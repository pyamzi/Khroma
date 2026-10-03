import { describe, it, expect } from 'vitest';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { tmpDir } from '../helpers.js';
import { makeTiffAs } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { photos, picks, projects, events } from '../../src/server/db/schema.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia } from '../../src/server/fs/photos.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';
import { addComment } from '../../src/server/domain/comments.js';
import { setPick } from '../../src/server/domain/selection.js';
import { finishRound } from '../../src/server/domain/transitions.js';
import { uploadFinal, deleteFinal, resolvePaths, pluginPicks, pluginComments, reportProgress, hintFor, FinalsError } from '../../src/server/domain/finals.js';

const jpeg = (w = 40, h = 30, bg = '#c33') => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).jpeg().toBuffer();
async function seed() {
  const root = await tmpDir(); const db = openDb(':memory:'); migrate(db);
  const p = defaultProjectJson('Wedding'); p.allowance = { included: 5, extraPrice: 0, slots: 5 };
  await mkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), { ...defaultClientJson('Smith'), emails: ['s@x.com'] });
  await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), p);
  for (const n of ['a', 'b']) await makeTiffAs(join(root, `Clients/Smith/Wedding/raw/${n}.dng`));
  await rescan(db, root); await indexProjectMedia(db, root, p.id!);
  const raws = db.select().from(photos).where(eq(photos.projectId, p.id!)).all().sort((x, y) => x.relPath.localeCompare(y.relPath));
  return { root, db, pid: p.id!, dir: join(root, 'Clients/Smith/Wedding'), a: raws[0]!, b: raws[1]! };
}

describe('finals domain', () => {
  it('uploads drafts keyed by source: same basename from two RAWs never collides; a re-upload replaces; same bytes are idempotent', async () => {
    const { root, db, pid, dir, a, b } = await seed();
    const r1 = await uploadFinal(db, root, { projectId: pid, name: 'DSC_0001.jpg', bytes: await jpeg(), sourcePhotoId: a.id, uploadId: 'u1', actor: 'plugin' });
    expect(r1).toMatchObject({ relPath: 'finals/DSC_0001.jpg', draftRelPath: 'finals/.draft/DSC_0001.jpg', replaced: false, idempotent: false });
    const r2 = await uploadFinal(db, root, { projectId: pid, name: 'DSC_0001.jpg', bytes: await jpeg(40, 30, '#3c3'), sourcePhotoId: b.id, uploadId: 'u2', actor: 'plugin' });
    expect(r2.relPath).toBe('finals/DSC_0001 (2).jpg');
    const r3 = await uploadFinal(db, root, { projectId: pid, name: 'DSC_0001.jpg', bytes: await jpeg(80, 60), sourcePhotoId: a.id, uploadId: 'u3', actor: 'plugin' });
    expect(r3).toMatchObject({ photoId: r1.photoId, replaced: true, idempotent: false });
    const r4 = await uploadFinal(db, root, { projectId: pid, name: 'DSC_0001.jpg', bytes: await jpeg(80, 60), sourcePhotoId: a.id, uploadId: 'u3', actor: 'plugin' });
    expect(r4).toMatchObject({ photoId: r1.photoId, idempotent: true });
    const rows = db.select().from(photos).where(eq(photos.projectId, pid)).all().filter((x) => x.stage === 'final');
    expect(rows.map((x) => [x.relPath, x.sourcePhotoId, x.live])).toEqual(expect.arrayContaining([['finals/DSC_0001.jpg', a.id, false], ['finals/DSC_0001 (2).jpg', b.id, false]]));
    expect((await readdir(join(dir, 'finals/.draft'))).sort()).toEqual(['DSC_0001 (2).jpg', 'DSC_0001.jpg']);
    await expect(uploadFinal(db, root, { projectId: pid, name: 'x.exe', bytes: Buffer.from('MZ'), uploadId: 'u5', actor: 'p' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(uploadFinal(db, root, { projectId: pid, name: 'x.jpg', bytes: Buffer.from('not a jpeg'), uploadId: 'u6', actor: 'p' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(uploadFinal(db, root, { projectId: pid, name: 'x.jpg', bytes: await jpeg(), sourcePhotoId: 'nope', uploadId: 'u7', actor: 'p' })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('deletes a draft but refuses a live final', async () => {
    const { root, db, pid, dir, a } = await seed();
    const r = await uploadFinal(db, root, { projectId: pid, name: 'f.jpg', bytes: await jpeg(), sourcePhotoId: a.id, uploadId: 'u1', actor: 'p' });
    await deleteFinal(db, root, { projectId: pid, photoId: r.photoId, actor: 'p' });
    await expect(stat(join(dir, 'finals/.draft/f.jpg'))).rejects.toThrow();
    expect(db.select().from(photos).all().filter((x) => x.stage === 'final')).toEqual([]);
    const live = await uploadFinal(db, root, { projectId: pid, name: 'g.jpg', bytes: await jpeg(), uploadId: 'u2', actor: 'p' });
    db.update(photos).set({ live: true, draftRelPath: null }).where(eq(photos.id, live.photoId)).run(); // as publication (M5) will do
    await expect(deleteFinal(db, root, { projectId: pid, photoId: live.photoId, actor: 'p' })).rejects.toMatchObject({ code: 'live_until_published' });
    await expect(deleteFinal(db, root, { projectId: pid, photoId: 'nope', actor: 'p' })).rejects.toBeInstanceOf(FinalsError);
  });
  it('resolves paths, returns submitted picks only, comments with hints, and progress for submitted RAWs', async () => {
    const { root, db, pid, a, b } = await seed();
    expect(resolvePaths(db, pid, ['raw/a.dng', 'raw/zzz.dng', '/raw/b.dng'])).toEqual({ 'raw/a.dng': a.id, 'raw/zzz.dng': null, '/raw/b.dng': b.id });
    const v = () => db.select().from(projects).where(eq(projects.id, pid)).get()!.selectionVersion;
    setPick(db, { projectId: pid, photoId: a.id, picked: true, byEmail: 's@x.com', expectedVersion: v() });
    expect(pluginPicks(db, pid)).toEqual({ round: 0, submittedAt: null, picks: [] }); // open round is not a commitment
    await finishRound(db, root, { projectId: pid, actor: 's@x.com', expectedVersion: v(), baseUrl: 'https://g' });
    const pk = pluginPicks(db, pid);
    expect(pk.round).toBe(1); expect(pk.submittedAt).toBeTruthy(); expect(pk.picks).toEqual([{ photoId: a.id, round: 1, relPath: 'raw/a.dng' }]);
    addComment(db, { photoId: a.id, author: 's@x.com', isAdmin: false, input: { text: 'soften', x: 0.05, y: 0.05, w: 0.1, h: 0.1 } });
    const f = await uploadFinal(db, root, { projectId: pid, name: 'a.jpg', bytes: await jpeg(), sourcePhotoId: a.id, uploadId: 'u1', actor: 'p' });
    addComment(db, { photoId: f.photoId, author: 'owner@x', isAdmin: true, input: { text: 'reply' } });
    const cs = pluginComments(db, pid);
    expect(cs.map((c) => [c.relPath, c.hint, c.sourceRelPath])).toEqual([['raw/a.dng', 'top-left', null], ['finals/a.jpg', null, 'raw/a.dng']]);
    expect(pluginComments(db, pid, cs[0]!.createdAt)).toHaveLength(1);
    expect(hintFor({ x: 0.4, y: 0.4, w: 0.2, h: 0.2, t: null })).toBe('centre'); expect(hintFor({ x: 0.8, y: 0.4, w: 0.1, h: 0.1, t: null })).toBe('right'); expect(hintFor({ x: null, y: null, w: null, h: null, t: 65 })).toBe('1:05');
    expect(reportProgress(db, { projectId: pid, reports: [{ photoId: a.id, state: 'editing' }, { photoId: b.id, state: 'editing' }], actor: 'p' })).toEqual({ updated: 1, skipped: 1 });
    expect(db.select().from(photos).where(eq(photos.id, a.id)).get()?.editState).toBe('editing');
    db.update(photos).set({ editState: 'done' }).where(eq(photos.id, a.id)).run();
    expect(reportProgress(db, { projectId: pid, reports: [{ photoId: a.id, state: 'none' }], actor: 'p' })).toEqual({ updated: 0, skipped: 1 });
    expect(db.select().from(events).all().some((e) => e.type === 'edit_progress')).toBe(true);
    void picks;
  });
});
