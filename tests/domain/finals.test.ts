import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { clients, photos, projects, events } from '../../src/server/db/schema.js';
import { memoryStorage, photoKey } from '../../src/server/storage.js';
import { defaultProjectMeta } from '../../src/server/domain/meta.js';
import { addPhoto } from '../../src/server/domain/photos.js';
import { addComment } from '../../src/server/domain/comments.js';
import { setPick } from '../../src/server/domain/selection.js';
import { finishRound } from '../../src/server/domain/transitions.js';
import { uploadFinal, deleteFinal, resolvePaths, pluginPicks, pluginComments, reportProgress, hintFor, FinalsError } from '../../src/server/domain/finals.js';
import { tiffBytes } from '../fixtures/make.js';
import { studioTestDb } from '../helpers.js';

const jpeg = (w = 40, h = 30, bg = '#c33') => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).jpeg().toBuffer();
const pid = 'p1';
async function seed() {
  const s = await studioTestDb(); const { db } = s; const storage = memoryStorage();
  const p = defaultProjectMeta('Wedding'); p.allowance = { included: 5, extraPrice: 0 };
  await db.insert(clients).values({ id: 'c1', name: 'Smith', emails: ['s@x.com'] });
  await db.insert(projects).values({ id: pid, clientId: 'c1', metadataJson: p as Record<string, unknown> });
  const a = await addPhoto(db, storage, { projectId: pid, relPath: 'raw/a.dng', stage: 'culling', bytes: await tiffBytes(), name: 'a.dng' });
  const b = await addPhoto(db, storage, { projectId: pid, relPath: 'raw/b.dng', stage: 'culling', bytes: await tiffBytes(), name: 'b.dng' });
  return { ...s, storage, a: { id: a.photoId }, b: { id: b.photoId } };
}

describe('finals domain', () => {
  it('uploads drafts keyed by source: same basename from two RAWs never collides; a re-upload replaces; same bytes are idempotent', async () => {
    const { db, storage, studioId, a, b } = await seed();
    const r1 = await uploadFinal(db, storage, { projectId: pid, name: 'DSC_0001.jpg', bytes: await jpeg(), sourcePhotoId: a.id, uploadId: 'u1', actor: 'plugin' });
    expect(r1).toMatchObject({ relPath: 'finals/DSC_0001.jpg', draftRelPath: 'finals/.draft/DSC_0001.jpg', replaced: false, idempotent: false });
    const r2 = await uploadFinal(db, storage, { projectId: pid, name: 'DSC_0001.jpg', bytes: await jpeg(40, 30, '#3c3'), sourcePhotoId: b.id, uploadId: 'u2', actor: 'plugin' });
    expect(r2.relPath).toBe('finals/DSC_0001 (2).jpg');
    const r3 = await uploadFinal(db, storage, { projectId: pid, name: 'DSC_0001.jpg', bytes: await jpeg(80, 60), sourcePhotoId: a.id, uploadId: 'u3', actor: 'plugin' });
    expect(r3).toMatchObject({ photoId: r1.photoId, replaced: true, idempotent: false });
    const r4 = await uploadFinal(db, storage, { projectId: pid, name: 'DSC_0001.jpg', bytes: await jpeg(80, 60), sourcePhotoId: a.id, uploadId: 'u3', actor: 'plugin' });
    expect(r4).toMatchObject({ photoId: r1.photoId, idempotent: true });
    const rows = (await db.select().from(photos).where(eq(photos.projectId, pid))).filter((x) => x.stage === 'final');
    expect(rows.map((x) => [x.relPath, x.sourcePhotoId, x.live])).toEqual(expect.arrayContaining([['finals/DSC_0001.jpg', a.id, false], ['finals/DSC_0001 (2).jpg', b.id, false]]));
    expect((await sharp((await storage.getBytes(photoKey(studioId, r1.photoId, 'draft')))!).metadata()).width).toBe(80);
    await expect(uploadFinal(db, storage, { projectId: pid, name: 'x.exe', bytes: Buffer.from('MZ'), uploadId: 'u5', actor: 'p' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(uploadFinal(db, storage, { projectId: pid, name: 'x.jpg', bytes: Buffer.from('not a jpeg'), uploadId: 'u6', actor: 'p' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(uploadFinal(db, storage, { projectId: pid, name: 'x.jpg', bytes: await jpeg(), sourcePhotoId: 'nope', uploadId: 'u7', actor: 'p' })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('a freshly uploaded final draft is not in the Library', async () => {
    const { db, storage } = await seed();
    const r = await uploadFinal(db, storage, { projectId: pid, name: 'f.jpg', bytes: await jpeg(), uploadId: 'u1', actor: 'p' });
    expect((await db.select().from(photos).where(eq(photos.id, r.photoId)))[0]!.inLibrary).toBe(false);
  });
  it('two concurrent same-name final uploads give one success and one conflict, never a database error', async () => {
    const { db, storage } = await seed();
    const bytes = await jpeg();
    const results = await Promise.allSettled(['u1', 'u2'].map((id) => uploadFinal(db, storage, { projectId: pid, name: 'same.jpg', bytes, uploadId: id, actor: 'p' })));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(failed[0]!.reason).toMatchObject({ name: 'FinalsError', code: 'conflict' });
    expect((await db.select().from(photos)).filter((x) => x.stage === 'final')).toHaveLength(1);
  });
  it('deletes a draft and its objects but refuses a live final', async () => {
    const { db, storage, studioId, a } = await seed();
    const r = await uploadFinal(db, storage, { projectId: pid, name: 'f.jpg', bytes: await jpeg(), sourcePhotoId: a.id, uploadId: 'u1', actor: 'p' });
    await deleteFinal(db, storage, { projectId: pid, photoId: r.photoId, actor: 'p' });
    expect(storage.keys().filter((k) => k.startsWith(`s/${studioId}/p/${r.photoId}/`))).toEqual([]);
    expect((await db.select().from(photos)).filter((x) => x.stage === 'final')).toEqual([]);
    const live = await uploadFinal(db, storage, { projectId: pid, name: 'g.jpg', bytes: await jpeg(), uploadId: 'u2', actor: 'p' });
    await db.update(photos).set({ live: true, draftRelPath: null }).where(eq(photos.id, live.photoId)); // as publication will do
    await expect(deleteFinal(db, storage, { projectId: pid, photoId: live.photoId, actor: 'p' })).rejects.toMatchObject({ code: 'live_until_published' });
    await expect(deleteFinal(db, storage, { projectId: pid, photoId: 'nope', actor: 'p' })).rejects.toBeInstanceOf(FinalsError);
  });
  it('resolves paths, returns submitted picks only, comments with hints, and progress for submitted RAWs', async () => {
    const { db, storage, a, b } = await seed();
    expect(await resolvePaths(db, pid, ['raw/a.dng', 'raw/zzz.dng', '/raw/b.dng'])).toEqual({ 'raw/a.dng': a.id, 'raw/zzz.dng': null, '/raw/b.dng': b.id });
    const v = async () => (await db.select().from(projects).where(eq(projects.id, pid)))[0]!.selectionVersion;
    await setPick(db, { projectId: pid, photoId: a.id, picked: true, byEmail: 's@x.com', expectedVersion: await v() });
    expect(await pluginPicks(db, pid)).toEqual({ round: 0, submittedAt: null, picks: [] }); // open round is not a commitment
    await finishRound(db, { projectId: pid, actor: 's@x.com', expectedVersion: await v(), baseUrl: 'https://g' });
    const pk = await pluginPicks(db, pid);
    expect(pk.round).toBe(1); expect(pk.submittedAt).toBeTruthy(); expect(pk.picks).toEqual([{ photoId: a.id, round: 1, relPath: 'raw/a.dng' }]);
    await addComment(db, { photoId: a.id, author: 's@x.com', isAdmin: false, input: { text: 'soften', x: 0.05, y: 0.05, w: 0.1, h: 0.1 } });
    const f = await uploadFinal(db, storage, { projectId: pid, name: 'a.jpg', bytes: await jpeg(), sourcePhotoId: a.id, uploadId: 'u1', actor: 'p' });
    await addComment(db, { photoId: f.photoId, author: 'owner@x', isAdmin: true, input: { text: 'reply' } });
    const cs = await pluginComments(db, pid);
    expect(cs.map((c) => [c.relPath, c.hint, c.sourceRelPath])).toEqual([['raw/a.dng', 'top-left', null], ['finals/a.jpg', null, 'raw/a.dng']]);
    expect(await pluginComments(db, pid, cs[0]!.createdAt)).toHaveLength(1);
    expect(hintFor({ x: 0.4, y: 0.4, w: 0.2, h: 0.2, t: null })).toBe('centre'); expect(hintFor({ x: 0.8, y: 0.4, w: 0.1, h: 0.1, t: null })).toBe('right'); expect(hintFor({ x: null, y: null, w: null, h: null, t: 65 })).toBe('1:05');
    expect(await reportProgress(db, { projectId: pid, reports: [{ photoId: a.id, state: 'editing' }, { photoId: b.id, state: 'editing' }], actor: 'p' })).toEqual({ updated: 1, skipped: 1 });
    expect((await db.select().from(photos).where(eq(photos.id, a.id)))[0]?.editState).toBe('editing');
    await db.update(photos).set({ editState: 'done' }).where(eq(photos.id, a.id));
    expect(await reportProgress(db, { projectId: pid, reports: [{ photoId: a.id, state: 'none' }], actor: 'p' })).toEqual({ updated: 0, skipped: 1 });
    expect((await db.select().from(events)).some((e) => e.type === 'edit_progress')).toBe(true);
  });
});
