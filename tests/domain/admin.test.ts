import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { projects, clients, photos, events } from '../../src/server/db/schema.js';
import { memoryStorage } from '../../src/server/storage.js';
import { ProjectMeta } from '../../src/server/domain/meta.js';
import { addPhoto } from '../../src/server/domain/photos.js';
import { createClient, createProject, updateClient, updateProjectHuman, setExtraPrice, markShot, reorderPhotos, setCover, projectEvents, projectInsights, AdminError } from '../../src/server/domain/admin.js';
import { jpegBytes } from '../fixtures/make.js';
import { studioTestDb } from '../helpers.js';

describe('admin domain', () => {
  it('creates a client and a project', async () => {
    const { db } = await studioTestDb();
    const c = await createClient(db, { name: ' Smith / Family ', emails: ['S@x.com', 's@x.com', ' '], phone: '555', notes: 'met at fair', actor: 'o' });
    const p = await createProject(db, { clientId: c.id, title: 'Wedding', date: '2026-06-14', included: 40, extraPrice: 1500, actor: 'o' });
    const [row] = await db.select().from(projects).where(eq(projects.id, p.id));
    expect(row!.clientId).toBe(c.id); expect(row!.date).toBe('2026-06-14');
    expect(ProjectMeta.parse(row!.metadataJson).allowance).toEqual({ included: 40, extraPrice: 1500 });
    expect((await db.select().from(clients).where(eq(clients.id, c.id)))[0]).toMatchObject({ name: 'Smith / Family', emails: ['s@x.com'], phone: '555', notes: 'met at fair' });
    await expect(createProject(db, { clientId: 'nope', title: 'X', actor: 'o' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createProject(db, { clientId: c.id, title: '  ', actor: 'o' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createClient(db, { name: ' ', emails: [], actor: 'o' })).rejects.toMatchObject({ code: 'invalid' });
    await updateClient(db, { clientId: c.id, patch: { name: 'Smiths', emails: ['a@x.com', 'B@x.com'] }, actor: 'o' });
    expect((await db.select().from(clients).where(eq(clients.id, c.id)))[0]).toMatchObject({ name: 'Smiths', emails: ['a@x.com', 'b@x.com'], phone: '555' });
    await expect(updateClient(db, { clientId: c.id, patch: { name: '' }, actor: 'o' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(updateClient(db, { clientId: 'nope', patch: { name: 'x' }, actor: 'o' })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('updates human fields only, changes price, marks shot once', async () => {
    const { db } = await studioTestDb();
    const c = await createClient(db, { name: 'A', emails: [], actor: 'o' });
    const p = await createProject(db, { clientId: c.id, title: 'W', actor: 'o' });
    const meta = await updateProjectHuman(db, { projectId: p.id, patch: { title: 'W2', downloads: 'none', comments: { culling: false, finals: true }, assignedTo: 'sam@x' }, actor: 'o' });
    expect(meta.title).toBe('W2'); expect(meta.downloads).toBe('none');
    await expect(updateProjectHuman(db, { projectId: p.id, patch: { allowance: { included: 99, extraPrice: 0 } }, actor: 'o' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(updateProjectHuman(db, { projectId: p.id, patch: { folders: { culling: 'x', finals: 'y' } }, actor: 'o' })).rejects.toMatchObject({ code: 'invalid' });
    await setExtraPrice(db, { projectId: p.id, extraPrice: 2500, actor: 'o' });
    const [row0] = await db.select().from(projects).where(eq(projects.id, p.id));
    expect(ProjectMeta.parse(row0!.metadataJson)).toMatchObject({ title: 'W2', allowance: { extraPrice: 2500 } });
    await markShot(db, { projectId: p.id, actor: 'o' });
    const [row] = await db.select().from(projects).where(eq(projects.id, p.id));
    expect(row!.productionState).toBe('shot'); expect(row!.stateVersion).toBe(2);
    await expect(markShot(db, { projectId: p.id, actor: 'o' })).rejects.toMatchObject({ code: 'guard' });
    expect((await projectEvents(db, p.id)).map((e) => e.type)).toEqual(expect.arrayContaining(['project_updated', 'price_changed', 'production_changed']));
  });
  it('reorders finals and sets a cover', async () => {
    const { db } = await studioTestDb(); const storage = memoryStorage();
    const c = await createClient(db, { name: 'A', emails: [], actor: 'o' });
    const p = await createProject(db, { clientId: c.id, title: 'W', actor: 'o' });
    const ids: Record<string, string> = {};
    for (const n of ['a', 'b', 'c']) ids[n] = (await addPhoto(db, storage, { projectId: p.id, relPath: `finals/${n}.jpg`, stage: 'final', bytes: await jpegBytes(), name: `${n}.jpg` })).photoId;
    const raw = await addPhoto(db, storage, { projectId: p.id, relPath: 'raw/r.jpg', stage: 'culling', bytes: await jpegBytes(), name: 'r.jpg' });
    await reorderPhotos(db, { projectId: p.id, ids: [ids.c!, ids.a!, ids.b!], actor: 'o' });
    const order = (await db.select().from(photos).where(eq(photos.projectId, p.id))).filter((x) => x.stage === 'final').sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.relPath);
    expect(order).toEqual(['finals/c.jpg', 'finals/a.jpg', 'finals/b.jpg']);
    await expect(reorderPhotos(db, { projectId: p.id, ids: [raw.photoId], actor: 'o' })).rejects.toThrow(AdminError);
    await setCover(db, { projectId: p.id, photoId: ids.b!, actor: 'o' });
    expect(ProjectMeta.parse((await db.select().from(projects).where(eq(projects.id, p.id)))[0]!.metadataJson).cover).toBe('finals/b.jpg');
    await expect(setCover(db, { projectId: p.id, photoId: raw.photoId, actor: 'o' })).rejects.toMatchObject({ code: 'invalid' });
  });
  it('derives insights from events', async () => {
    const { db } = await studioTestDb();
    const c = await createClient(db, { name: 'A', emails: [], actor: 'o' });
    const p = await createProject(db, { clientId: c.id, title: 'W', actor: 'o' });
    await db.insert(events).values([
      { projectId: p.id, actor: 's@x', type: 'viewed', payload: {}, at: '2026-06-01T10:00:00Z' }, { projectId: p.id, actor: 's@x', type: 'viewed', payload: {}, at: '2026-06-02T10:00:00Z' },
      { projectId: p.id, actor: 't@x', type: 'viewed', payload: {}, at: '2026-06-02T11:00:00Z' }, { projectId: p.id, actor: 's@x', type: 'picked', payload: {}, at: '2026-06-02T11:05:00Z' },
      { projectId: p.id, actor: 's@x', type: 'commented', payload: {}, at: '2026-06-03T09:00:00Z' },
    ]);
    const i = await projectInsights(db, p.id);
    expect(i.views).toBe(3); expect(i.uniqueVisitors).toBe(2);
    expect(i.byDay).toEqual([{ day: '2026-06-01', views: 1, picks: 0, comments: 0 }, { day: '2026-06-02', views: 2, picks: 1, comments: 0 }, { day: '2026-06-03', views: 0, picks: 0, comments: 1 }]);
    expect(i.visitors[0]).toMatchObject({ actor: 's@x', views: 2 });
  });
});
