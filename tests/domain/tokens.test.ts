import { describe, it, expect } from 'vitest';
import { clients, projects, sessions } from '../../src/server/db/schema.js';
import { asSystem } from '../../src/server/db/tenancy.js';
import { createPluginToken, listPluginTokens, revokePluginToken, TokenError } from '../../src/server/domain/tokens.js';
import { sessionFromToken } from '../../src/server/auth/magic.js';
import { studioTestDb } from '../helpers.js';

describe('plugin tokens', () => {
  it('creates a hashed token shown once, lists without the secret, revokes', async () => {
    const { db, studioId } = await studioTestDb();
    await db.insert(clients).values({ id: 'c1', name: 'A', emails: [] });
    await db.insert(projects).values({ id: 'p1', clientId: 'c1', metadataJson: {} });
    const { id, token } = await createPluginToken(db, { name: 'Sam’s MacBook', scope: 'read+write', actor: 'owner@x' });
    expect(token).toMatch(/^ogp_[A-Za-z0-9_-]{40,}$/);
    expect(JSON.stringify(await db.select().from(sessions))).not.toContain(token);
    expect(await listPluginTokens(db)).toEqual([expect.objectContaining({ id, name: 'Sam’s MacBook', scope: 'read+write', projectId: null, createdBy: 'owner@x' })]);
    const s = (await asSystem(db, (tx) => sessionFromToken(tx, token)))!;
    expect([s.kind, s.scope, s.studioId]).toEqual(['plugin', 'read+write', studioId]);
    await revokePluginToken(db, { id, actor: 'owner@x' });
    expect(await asSystem(db, (tx) => sessionFromToken(tx, token))).toBeNull(); expect(await listPluginTokens(db)).toEqual([]);
    await expect(revokePluginToken(db, { id, actor: 'owner@x' })).rejects.toThrow(TokenError);
    await expect(createPluginToken(db, { name: '   ', scope: 'read', actor: 'o' })).rejects.toThrow(/invalid/);
    await expect(createPluginToken(db, { name: 'x', scope: 'read', projectId: 'nope', actor: 'o' })).rejects.toThrow(/not_found/);
  });
});
