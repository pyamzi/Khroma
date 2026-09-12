import { describe, it, expect } from 'vitest';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { makeJpeg } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { projects, clients, photos, events } from '../../src/server/db/schema.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia } from '../../src/server/fs/photos.js';
import { readJson } from '../../src/server/fs/json.js';
import { ProjectJson } from '../../src/server/fs/schemas.js';
import { createClient, createProject, updateClient, updateProjectHuman, setExtraPrice, markShot, reorderPhotos, setCover, setSharedFiles, projectEvents, projectInsights, AdminError } from '../../src/server/domain/admin.js';

async function fresh() { const root = await tmpDir(); await mkdir(join(root, 'Clients'), { recursive: true }); const db = openDb(':memory:'); migrate(db); await rescan(db, root); return { root, db }; }

describe('admin domain', () => {
  it('creates a client and a project on disk and in the database', async () => {
    const { root, db } = await fresh();
    const c = await createClient(db, root, { name: 'Smith / Family', emails: ['S@x.com'], actor: 'o' });
    expect(c.folderPath).toBe('Clients/Smith - Family');
    const c2 = await createClient(db, root, { name: 'Smith / Family', emails: [], actor: 'o' });
    expect(c2.folderPath).toBe('Clients/Smith - Family (2)');
    const p = await createProject(db, root, { clientId: c.id, title: 'Wedding', date: '2026-06-14', included: 40, extraPrice: 1500, actor: 'o' });
    expect(p.folderPath).toBe('Clients/Smith - Family/Wedding');
    expect((await stat(join(root, p.folderPath, 'raw'))).isDirectory()).toBe(true);
    const row = db.select().from(projects).where(eq(projects.id, p.id)).get()!;
    expect(row.clientId).toBe(c.id); expect(row.date).toBe('2026-06-14');
    expect(db.select().from(clients).where(eq(clients.id, c.id)).get()?.emails).toEqual(['s@x.com']);
    await expect(createProject(db, root, { clientId: 'nope', title: 'X', actor: 'o' })).rejects.toMatchObject({ code: 'not_found' });
    await updateClient(db, root, { clientId: c.id, patch: { name: 'Smiths', emails: ['a@x.com', 'B@x.com'] }, actor: 'o' });
    expect(db.select().from(clients).where(eq(clients.id, c.id)).get()).toMatchObject({ name: 'Smiths', emails: ['a@x.com', 'b@x.com'], folderPath: 'Clients/Smith - Family' });
  });
  it('updates human fields only, changes price, marks shot once', async () => {
    const { root, db } = await fresh();
    const c = await createClient(db, root, { name: 'A', emails: [], actor: 'o' });
    const p = await createProject(db, root, { clientId: c.id, title: 'W', actor: 'o' });
    const meta = await updateProjectHuman(db, root, { projectId: p.id, patch: { title: 'W2', downloads: 'none', comments: { culling: false, finals: true }, assignedTo: 'sam@x' }, actor: 'o' });
    expect(meta.title).toBe('W2'); expect(meta.downloads).toBe('none');
    await expect(updateProjectHuman(db, root, { projectId: p.id, patch: { allowance: { included: 99, extraPrice: 0, slots: 99 } } as never, actor: 'o' })).rejects.toMatchObject({ code: 'invalid' });
    await setExtraPrice(db, root, { projectId: p.id, extraPrice: 2500, actor: 'o' });
    const file = await readJson(join(root, p.folderPath, 'project.json'), ProjectJson);
    expect(file.ok && file.data.allowance.extraPrice).toBe(2500); expect(file.ok && file.data.title).toBe('W2');
    await markShot(db, root, { projectId: p.id, actor: 'o' });
    const row = db.select().from(projects).where(eq(projects.id, p.id)).get()!;
    expect(row.productionState).toBe('shot'); expect(row.stateVersion).toBe(2);
    await expect(markShot(db, root, { projectId: p.id, actor: 'o' })).rejects.toMatchObject({ code: 'guard' });
    expect(projectEvents(db, p.id).map((e) => e.type)).toEqual(expect.arrayContaining(['project_updated', 'price_changed', 'production_changed']));
  });
  it('reorders finals, sets a cover, toggles shared files', async () => {
    const { root, db } = await fresh();
    const c = await createClient(db, root, { name: 'A', emails: [], actor: 'o' });
    const p = await createProject(db, root, { clientId: c.id, title: 'W', actor: 'o' });
    for (const n of ['a', 'b', 'c']) await makeJpeg(join(root, p.folderPath, `finals/${n}.jpg`));
    await makeJpeg(join(root, p.folderPath, 'raw/r.jpg')); await writeFile(join(root, p.folderPath, 'Timeline.pdf'), '%PDF-1.4');
    await indexProjectMedia(db, root, p.id);
    const all = db.select().from(photos).where(eq(photos.projectId, p.id)).all();
    const finals = all.filter((x) => x.stage === 'final').sort((x, y) => x.relPath.localeCompare(y.relPath));
    const raw = all.find((x) => x.stage === 'culling')!;
    reorderPhotos(db, { projectId: p.id, ids: [finals[2]!.id, finals[0]!.id, finals[1]!.id], actor: 'o' });
    const order = db.select().from(photos).where(eq(photos.projectId, p.id)).all().filter((x) => x.stage === 'final').sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.relPath);
    expect(order).toEqual(['finals/c.jpg', 'finals/a.jpg', 'finals/b.jpg']);
    expect(() => reorderPhotos(db, { projectId: p.id, ids: [raw.id], actor: 'o' })).toThrow(AdminError);
    await setCover(db, root, { projectId: p.id, photoId: finals[1]!.id, actor: 'o' });
    expect(ProjectJson.parse(db.select().from(projects).where(eq(projects.id, p.id)).get()!.metadataJson).cover).toBe('finals/b.jpg');
    expect(await setSharedFiles(db, root, { projectId: p.id, rel: 'Timeline.pdf', shared: true, actor: 'o' })).toEqual(['Timeline.pdf']);
    await expect(setSharedFiles(db, root, { projectId: p.id, rel: 'raw/r.jpg', shared: true, actor: 'o' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(setSharedFiles(db, root, { projectId: p.id, rel: 'nope.pdf', shared: true, actor: 'o' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await setSharedFiles(db, root, { projectId: p.id, rel: 'Timeline.pdf', shared: false, actor: 'o' })).toEqual([]);
  });
  it('derives insights from events', async () => {
    const { root, db } = await fresh();
    const c = await createClient(db, root, { name: 'A', emails: [], actor: 'o' });
    const p = await createProject(db, root, { clientId: c.id, title: 'W', actor: 'o' });
    db.insert(events).values([
      { projectId: p.id, actor: 's@x', type: 'viewed', payload: {}, at: '2026-06-01T10:00:00Z' }, { projectId: p.id, actor: 's@x', type: 'viewed', payload: {}, at: '2026-06-02T10:00:00Z' },
      { projectId: p.id, actor: 't@x', type: 'viewed', payload: {}, at: '2026-06-02T11:00:00Z' }, { projectId: p.id, actor: 's@x', type: 'picked', payload: {}, at: '2026-06-02T11:05:00Z' },
      { projectId: p.id, actor: 's@x', type: 'commented', payload: {}, at: '2026-06-03T09:00:00Z' },
    ]).run();
    const i = projectInsights(db, p.id);
    expect(i.views).toBe(3); expect(i.uniqueVisitors).toBe(2);
    expect(i.byDay).toEqual([{ day: '2026-06-01', views: 1, picks: 0, comments: 0 }, { day: '2026-06-02', views: 2, picks: 1, comments: 0 }, { day: '2026-06-03', views: 0, picks: 0, comments: 1 }]);
    expect(i.visitors[0]).toMatchObject({ actor: 's@x', views: 2 });
  });
});
