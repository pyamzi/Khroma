import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, users } from '../../src/server/db/schema.js';
import { canAccessProject, listProjectsFor } from '../../src/server/http/access.js';
import type { SessionRow } from '../../src/server/auth/magic.js';

function fresh() {
  const db = openDb(':memory:'); migrate(db);
  db.insert(clients).values([{ id: 'c1', folderPath: 'Clients/A', name: 'A', emails: ['Sarah@x'] }, { id: 'c2', folderPath: 'Clients/B', name: 'B', emails: ['bob@x'] }]).run();
  db.insert(projects).values([
    { id: 'p1', clientId: 'c1', folderPath: 'Clients/A/P1', metadataJson: {} },
    { id: 'p2', clientId: 'c2', folderPath: 'Clients/B/P2', metadataJson: {} },
    { id: 'p3', clientId: 'c1', folderPath: 'Clients/A/P3', metadataJson: {}, available: false },
    { id: 'p4', clientId: 'c1', folderPath: 'Clients/A/P4', metadataJson: {}, archivedAt: '2026-01-01T00:00:00Z' },
    { id: 'p5', clientId: 'c1', folderPath: 'Clients/A/P5', metadataJson: {}, transferPending: true },
  ]).run();
  db.insert(users).values({ id: 'u1', email: 'owner@x', role: 'owner' }).run();
  const s = (id: string, kind: SessionRow['kind'], subject: string, projectId: string | null = null): SessionRow =>
    ({ id, kind, subject, projectId, expiresAt: '2999-01-01T00:00:00Z', scope: 'read', loginTokenHash: null, tokenHash: null, redeemedAt: null, nickname: null, createdAt: '' });
  return { db, sarah: s('s1', 'client', 'sarah@x'), bob: s('s2', 'client', 'bob@x'), owner: s('s3', 'admin', 'owner@x'), guest: s('s4', 'guest', 'Guest 1', 'p1'), impostor: s('s5', 'admin', 'nobody@x'), plugin: s('s6', 'plugin', 'tok', 'p1') };
}
const P = (db: ReturnType<typeof openDb>, id: string) => db.select().from(projects).all().find((p) => p.id === id)!;

describe('canAccessProject', () => {
  it('clients see only their own available projects', () => {
    const { db, sarah, bob } = fresh();
    expect(canAccessProject(db, sarah, P(db, 'p1'))).toBe('ok');
    expect(canAccessProject(db, bob, P(db, 'p1'))).toBe('forbidden');
    expect(canAccessProject(db, sarah, P(db, 'p3'))).toBe('forbidden');   // unavailable
    expect(canAccessProject(db, sarah, P(db, 'p4'))).toBe('forbidden');   // archived
    expect(canAccessProject(db, sarah, P(db, 'p5'))).toBe('forbidden');   // transfer pending
    expect(canAccessProject(db, null, P(db, 'p1'))).toBe('forbidden');
  });
  it('admins see everything; an admin session without a users row sees nothing', () => {
    const { db, owner, impostor } = fresh();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) expect(canAccessProject(db, owner, P(db, id))).toBe('ok');
    expect(canAccessProject(db, impostor, P(db, 'p1'))).toBe('forbidden');
  });
  it('guests are bound to their session project; plugin tokens are not granted yet', () => {
    const { db, guest, plugin } = fresh();
    expect(canAccessProject(db, guest, P(db, 'p1'))).toBe('ok');
    expect(canAccessProject(db, guest, P(db, 'p2'))).toBe('forbidden');
    expect(canAccessProject(db, plugin, P(db, 'p1'))).toBe('forbidden');
  });
  it('lists projects per session', () => {
    const { db, sarah, owner, guest } = fresh();
    expect(listProjectsFor(db, sarah).map((p) => p.id)).toEqual(['p1']);
    expect(listProjectsFor(db, owner)).toHaveLength(5);
    expect(listProjectsFor(db, guest).map((p) => p.id)).toEqual(['p1']);
    expect(listProjectsFor(db, null)).toEqual([]);
  });
});
