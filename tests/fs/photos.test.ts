import { describe, it, expect } from 'vitest';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { makeJpeg, makeTiffAs } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { photos, jobs, events } from '../../src/server/db/schema.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia, makePreviewHandlers, cachePaths } from '../../src/server/fs/photos.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';

async function project(root: string) {
  const c = defaultClientJson('Smith'); const p = defaultProjectJson('Wedding');
  await mkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await mkdir(join(root, 'Clients/Smith/Wedding/finals/Ceremony'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), c);
  await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), p);
  const db = openDb(':memory:'); migrate(db); await rescan(db, root);
  const handlers = makePreviewHandlers(root);
  const drain = async () => { while ((await runOnce(db, handlers)) === 'ran') { /* */ } };
  return { db, pid: p.id!, dir: join(root, 'Clients/Smith/Wedding'), drain };
}

describe('indexProjectMedia', () => {
  it('indexes raw files as culling photos and finals with sections', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeTiffAs(join(dir, 'raw/a.dng')); await makeTiffAs(join(dir, 'raw/b.dng'));
    await makeJpeg(join(dir, 'finals/Ceremony/c.jpg')); await writeFile(join(dir, 'raw/notes.txt'), 'x');
    const r = await indexProjectMedia(db, root, pid);
    expect(r.added).toBe(3); expect(r.skipped).toEqual(['raw/notes.txt']);
    const rows = db.select().from(photos).where(eq(photos.projectId, pid)).all();
    expect(rows.filter((p) => p.stage === 'culling')).toHaveLength(2);
    expect(rows.find((p) => p.relPath === 'finals/Ceremony/c.jpg')?.section).toBe('Ceremony');
    expect(db.select().from(jobs).all().filter((j) => j.kind === 'preview')).toHaveLength(3);
  });
  it('is a no-op for unchanged files and re-queues a preview on content change', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeTiffAs(join(dir, 'raw/a.dng'));
    await indexProjectMedia(db, root, pid);
    let r = await indexProjectMedia(db, root, pid); expect(r).toMatchObject({ added: 0, updated: 0, missing: 0 });
    expect(db.select().from(jobs).all()).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 10));
    await makeJpeg(join(dir, 'raw/a.dng'));                    // jpeg bytes under a raw extension → unsupported now
    r = await indexProjectMedia(db, root, pid); expect(r.missing).toBe(1);
    expect(db.select().from(photos).all()[0]?.missing).toBe(true);
  });
  it('marks a renamed raw as missing + new, never merges', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeTiffAs(join(dir, 'raw/a.dng')); await indexProjectMedia(db, root, pid);
    await rename(join(dir, 'raw/a.dng'), join(dir, 'raw/z.dng'));
    const r = await indexProjectMedia(db, root, pid);
    expect(r).toMatchObject({ added: 1, missing: 1 });
    expect(db.select().from(photos).all()).toHaveLength(2);
  });
  it('treats new finals after first index as drafts, and .draft files as drafts', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeJpeg(join(dir, 'finals/live.jpg'));
    await indexProjectMedia(db, root, pid);                          // first index: live
    await makeJpeg(join(dir, 'finals/new.jpg'));
    await mkdir(join(dir, 'finals/.draft'), { recursive: true }); await makeJpeg(join(dir, 'finals/.draft/staged.jpg'));
    const r = await indexProjectMedia(db, root, pid);
    expect(r.drafts).toBe(2);
    const rows = db.select().from(photos).all();
    expect(rows.find((p) => p.relPath === 'finals/new.jpg')?.draftRelPath).toBe('finals/.draft/new.jpg');
    expect((await stat(join(dir, 'finals/.draft/new.jpg'))).isFile()).toBe(true);
    await expect(stat(join(dir, 'finals/new.jpg'))).rejects.toThrow();
    expect(rows.find((p) => p.relPath === 'finals/staged.jpg')?.draftRelPath).toBe('finals/.draft/staged.jpg');
    expect(rows.find((p) => p.relPath === 'finals/live.jpg')?.draftRelPath).toBeNull();
  });
  it('a draft staged for an existing live file never touches the live file', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeJpeg(join(dir, 'finals/live.jpg'), 64, 48);
    await indexProjectMedia(db, root, pid);
    const before = (await stat(join(dir, 'finals/live.jpg'))).size;
    await mkdir(join(dir, 'finals/.draft'), { recursive: true }); await makeJpeg(join(dir, 'finals/.draft/live.jpg'), 128, 96);
    const r = await indexProjectMedia(db, root, pid);
    expect(r).toMatchObject({ added: 0, updated: 1, drafts: 1 });
    const row = db.select().from(photos).all()[0]!;
    expect(row.relPath).toBe('finals/live.jpg'); expect(row.draftRelPath).toBe('finals/.draft/live.jpg');
    expect((await stat(join(dir, 'finals/live.jpg'))).size).toBe(before);
  });
  it('an external overwrite of a live final is logged, not reverted', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeJpeg(join(dir, 'finals/live.jpg'), 64, 48);
    await indexProjectMedia(db, root, pid);
    await new Promise((res) => setTimeout(res, 10));
    await makeJpeg(join(dir, 'finals/live.jpg'), 128, 96);
    const r = await indexProjectMedia(db, root, pid);
    expect(r.updated).toBe(1);
    expect(db.select().from(events).all().some((e) => e.type === 'replaced_externally')).toBe(true);
  });
  it('preview job writes cache files and records failure as an event', async () => {
    const root = await tmpDir(); const { db, pid, dir, drain } = await project(root);
    await makeTiffAs(join(dir, 'raw/a.dng')); await makeJpeg(join(dir, 'finals/f.jpg'), 640, 480);
    await indexProjectMedia(db, root, pid); await drain();
    for (const p of db.select().from(photos).all()) {
      const { preview, thumb } = cachePaths(root, { folderPath: 'Clients/Smith/Wedding' }, p.id);
      expect((await stat(thumb)).isFile()).toBe(true);
      if (p.stage === 'culling') expect((await stat(preview)).isFile()).toBe(true);
      expect(p.width).toBeGreaterThan(0);
    }
    await writeFile(join(dir, 'raw/bad.nef'), Buffer.from('49492a00', 'hex')); // valid TIFF header, no image
    await indexProjectMedia(db, root, pid); await drain();
    expect(db.select().from(events).all().some((e) => e.type === 'preview_failed')).toBe(true);
    expect(db.select().from(jobs).all().every((j) => j.state === 'done')).toBe(true);
  });
});
