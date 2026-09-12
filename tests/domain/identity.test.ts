import { describe, it, expect } from 'vitest';
import { mkdir, rename, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { makeJpeg } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { projects, photos, picks, comments } from '../../src/server/db/schema.js';
import { rescan, currentIssues } from '../../src/server/fs/index.js';
import { indexProjectMedia } from '../../src/server/fs/photos.js';
import { writeJsonAtomic, readJson } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson, ProjectJson } from '../../src/server/fs/schemas.js';
import { adoptDuplicate, remapPhoto, IdentityError } from '../../src/server/domain/identity.js';

async function seed() {
  const root = await tmpDir(); const db = openDb(':memory:'); migrate(db);
  const p = defaultProjectJson('Wedding'); p.allowance = { included: 5, extraPrice: 0, slots: 5 };
  await mkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), { ...defaultClientJson('Smith'), emails: ['s@x.com'] });
  await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), p);
  await makeJpeg(join(root, 'Clients/Smith/Wedding/raw/a.jpg'));
  await rescan(db, root); await indexProjectMedia(db, root, p.id!);
  return { root, db, pid: p.id! };
}

describe('identity resolution', () => {
  it('adopts a duplicated project folder with a fresh id and no transactional state', async () => {
    const { root, db, pid } = await seed();
    const a = db.select().from(photos).get()!;
    db.insert(picks).values({ projectId: pid, photoId: a.id, round: 1, byEmail: 's@x.com', state: 'confirmed' }).run();
    await cp(join(root, 'Clients/Smith/Wedding'), join(root, 'Clients/Smith/Wedding copy'), { recursive: true });
    await rescan(db, root);
    expect(currentIssues().filter((i) => i.kind === 'duplicate_id')).toHaveLength(2);
    await expect(adoptDuplicate(db, root, { rel: 'Clients/Smith/Wedding copy', actor: 'o' })).resolves.toBeTruthy();
    const file = await readJson(join(root, 'Clients/Smith/Wedding copy/project.json'), ProjectJson);
    expect(file.ok && file.data.id).not.toBe(pid); expect(file.ok && file.data.allowance.included).toBe(5);
    expect(file.ok && file.data.state.production).toBe('not_started');
    const rows = db.select().from(projects).all(); expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === pid)).toMatchObject({ available: true, folderPath: 'Clients/Smith/Wedding' });
    expect(db.select().from(picks).all()).toHaveLength(1);
    expect(currentIssues()).toEqual([]);
    await expect(adoptDuplicate(db, root, { rel: 'Clients/Smith/Wedding copy', actor: 'o' })).rejects.toMatchObject({ code: 'not_duplicate' });
  });
  it('remaps a renamed RAW onto its missing row, keeping picks and comments', async () => {
    const { root, db, pid } = await seed();
    const a = db.select().from(photos).get()!;
    db.insert(picks).values({ projectId: pid, photoId: a.id, round: 1, byEmail: 's@x.com', state: 'confirmed' }).run();
    db.insert(comments).values({ id: 'c1', photoId: a.id, author: 's@x.com', stage: 'culling', text: 'hi' }).run();
    await rename(join(root, 'Clients/Smith/Wedding/raw/a.jpg'), join(root, 'Clients/Smith/Wedding/raw/z.jpg'));
    await indexProjectMedia(db, root, pid);
    const rows = db.select().from(photos).all(); expect(rows).toHaveLength(2);
    const fresh = rows.find((r) => r.relPath === 'raw/z.jpg')!;
    expect(() => remapPhoto(db, { projectId: pid, missingPhotoId: fresh.id, newPhotoId: a.id, actor: 'o' })).toThrow(IdentityError);
    remapPhoto(db, { projectId: pid, missingPhotoId: a.id, newPhotoId: fresh.id, actor: 'o' });
    const after = db.select().from(photos).all(); expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: a.id, relPath: 'raw/z.jpg', missing: false });
    expect(db.select().from(picks).where(eq(picks.photoId, a.id)).all()).toHaveLength(1);
    expect(db.select().from(comments).where(eq(comments.photoId, a.id)).all()).toHaveLength(1);
    await indexProjectMedia(db, root, pid); expect(db.select().from(photos).all()).toHaveLength(1);
  });
});
