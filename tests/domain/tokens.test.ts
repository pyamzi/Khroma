import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, sessions } from '../../src/server/db/schema.js';
import { createPluginToken, listPluginTokens, revokePluginToken, TokenError } from '../../src/server/domain/tokens.js';
import { sessionFromToken } from '../../src/server/auth/magic.js';
import { canAccessProject } from '../../src/server/http/access.js';

function fresh() {
  const db = openDb(':memory:'); migrate(db);
  db.insert(clients).values({ id: 'c1', folderPath: 'Clients/A', name: 'A', emails: [] }).run();
  db.insert(projects).values([{ id: 'p1', clientId: 'c1', folderPath: 'Clients/A/P1', metadataJson: {} }, { id: 'p2', clientId: 'c1', folderPath: 'Clients/A/P2', metadataJson: {} }, { id: 'p3', clientId: 'c1', folderPath: 'Clients/A/P3', metadataJson: {}, archivedAt: '2026-01-01T00:00:00Z' }]).run();
  return db;
}

describe('plugin tokens', () => {
  it('creates a hashed token shown once, lists without the secret, revokes', () => {
    const db = fresh();
    const { id, token } = createPluginToken(db, { name: 'Sam’s MacBook', scope: 'read+write', actor: 'owner@x' });
    expect(token).toMatch(/^ogp_[A-Za-z0-9_-]{40,}$/);
    expect(JSON.stringify(db.select().from(sessions).all())).not.toContain(token);
    expect(listPluginTokens(db)).toEqual([expect.objectContaining({ id, name: 'Sam’s MacBook', scope: 'read+write', projectId: null, createdBy: 'owner@x' })]);
    const s = sessionFromToken(db, token)!; expect(s.kind).toBe('plugin'); expect(s.scope).toBe('read+write');
    revokePluginToken(db, { id, actor: 'owner@x' });
    expect(sessionFromToken(db, token)).toBeNull(); expect(listPluginTokens(db)).toEqual([]);
    expect(() => revokePluginToken(db, { id, actor: 'owner@x' })).toThrow(TokenError);
    expect(() => createPluginToken(db, { name: '   ', scope: 'read', actor: 'o' })).toThrow(/invalid/);
    expect(() => createPluginToken(db, { name: 'x', scope: 'read', projectId: 'nope', actor: 'o' })).toThrow(/not_found/);
  });
  it('scopes access to one project when asked, and never to archived projects', () => {
    const db = fresh();
    const all = sessionFromToken(db, createPluginToken(db, { name: 'all', scope: 'read', actor: 'o' }).token)!;
    const one = sessionFromToken(db, createPluginToken(db, { name: 'one', scope: 'read', projectId: 'p1', actor: 'o' }).token)!;
    const P = (id: string) => db.select().from(projects).all().find((p) => p.id === id)!;
    expect(canAccessProject(db, all, P('p1'))).toBe('ok'); expect(canAccessProject(db, all, P('p2'))).toBe('ok'); expect(canAccessProject(db, all, P('p3'))).toBe('forbidden');
    expect(canAccessProject(db, one, P('p1'))).toBe('ok'); expect(canAccessProject(db, one, P('p2'))).toBe('forbidden');
  });
});
