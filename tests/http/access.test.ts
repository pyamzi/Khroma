import { describe, it, expect } from 'vitest';
import { clients, projects, photos } from '../../src/server/db/schema.js';
import type { Db } from '../../src/server/db/client.js';
import { canAccessProject, listProjectsFor } from '../../src/server/http/access.js';
import type { Viewer } from '../../src/server/http/session.js';
import { studioTestDb } from '../helpers.js';
import { withStudio } from '../../src/server/db/tenancy.js';
import { photoKey } from '../../src/server/storage.js';
import { jpegBytes } from '../fixtures/make.js';
import { boot } from './boot.js';

async function fresh() {
  const { db, studioId } = await studioTestDb({ ownerEmail: 'owner@x' });
  await db.insert(clients).values([{ id: 'c1', name: 'A', emails: ['sarah@x'] }, { id: 'c2', name: 'B', emails: ['bob@x'] }]);
  await db.insert(projects).values([
    { id: 'p1', clientId: 'c1', metadataJson: {} }, { id: 'p2', clientId: 'c2', metadataJson: {} },
    { id: 'p4', clientId: 'c1', metadataJson: {}, archivedAt: '2026-01-01T00:00:00Z' },
  ]);
  const s = (id: string, kind: Viewer['kind'], subject: string, projectId: string | null = null, sid = studioId): Viewer =>
    ({ id, studioId: sid, kind, subject, projectId, scope: 'read', nickname: null });
  return { db, sarah: s('s1', 'client', 'sarah@x'), bob: s('s2', 'client', 'bob@x'), owner: s('s3', 'admin', 'owner@x'), guest: s('s4', 'guest', 'Guest 1', 'p1'),
    impostor: s('s5', 'admin', 'nobody@x'), plugin: s('s6', 'plugin', 'tok', 'p1'), pluginAll: s('s7', 'plugin', 'tok'), foreignOwner: s('s8', 'admin', 'owner@x', null, 'another-studio') };
}
const P = async (db: Db, id: string) => (await db.select().from(projects)).find((p) => p.id === id)!;

describe('canAccessProject', () => {
  it('clients see only their own active projects', async () => {
    const { db, sarah, bob } = await fresh();
    expect(await canAccessProject(db, sarah, await P(db, 'p1'))).toBe('ok');
    expect(await canAccessProject(db, bob, await P(db, 'p1'))).toBe('forbidden');
    expect(await canAccessProject(db, sarah, await P(db, 'p4'))).toBe('forbidden');   // archived
    expect(await canAccessProject(db, null, await P(db, 'p1'))).toBe('forbidden');
  });
  it('admins see everything in their Studio; an admin session without a users row, or from another Studio, sees nothing', async () => {
    const { db, owner, impostor, foreignOwner } = await fresh();
    for (const id of ['p1', 'p2', 'p4']) expect(await canAccessProject(db, owner, await P(db, id))).toBe('ok');
    expect(await canAccessProject(db, impostor, await P(db, 'p1'))).toBe('forbidden');
    expect(await canAccessProject(db, foreignOwner, await P(db, 'p1'))).toBe('forbidden');
  });
  it('guests and project-scoped plugin tokens are bound to their project; plugins never see archived projects', async () => {
    const { db, guest, plugin, pluginAll } = await fresh();
    expect(await canAccessProject(db, guest, await P(db, 'p1'))).toBe('ok');
    expect(await canAccessProject(db, guest, await P(db, 'p2'))).toBe('forbidden');
    expect(await canAccessProject(db, plugin, await P(db, 'p1'))).toBe('ok');
    expect(await canAccessProject(db, plugin, await P(db, 'p2'))).toBe('forbidden');
    expect(await canAccessProject(db, pluginAll, await P(db, 'p2'))).toBe('ok');
    expect(await canAccessProject(db, pluginAll, await P(db, 'p4'))).toBe('forbidden');
  });
  it('lists projects per session', async () => {
    const { db, sarah, owner, guest } = await fresh();
    expect((await listProjectsFor(db, sarah)).map((p) => p.id)).toEqual(['p1']);
    expect(await listProjectsFor(db, owner)).toHaveLength(3);
    expect((await listProjectsFor(db, guest)).map((p) => p.id)).toEqual(['p1']);
    expect(await listProjectsFor(db, null)).toEqual([]);
  });
});

describe('Library photos', () => {
  it('a Library photo is reachable by its Studio admin only', async () => {
    const b = await boot();
    const A = await b.signupOwner('a-owner@x.com', 'Alpha'); const B = await b.signupOwner('b-owner@x.com', 'Beta');
    await b.seedProject(A.cookie, { emails: ['a-client@x.com'] });
    const client = await b.signIn('a-client@x.com', 'Alpha');
    await withStudio(b.db, A.studioId, (tx) => tx.insert(photos).values({ id: 'lib1', studioId: A.studioId, projectId: null, relPath: 'library/lib1/a.jpg', stage: 'final', kind: 'photo', checksum: '' }));
    await b.storage.put(photoKey(A.studioId, 'lib1', 'preview'), await jpegBytes(40, 30), 'image/jpeg');
    const get = (cookie: string) => b.api('/api/photos/lib1/preview', { cookie });
    expect((await get(A.cookie)).status).toBe(200);
    expect((await get(client)).status).toBe(404);
    expect((await get(B.cookie)).status).toBe(404);
    expect((await b.api('/api/photos/lib1/preview')).status).toBe(404);
  });
});
