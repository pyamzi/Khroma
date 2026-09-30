import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { asSystem } from '../../src/server/db/tenancy.js';
import { createMagicLink, redeemMagicLink, sessionFromToken, signOut, TTL } from '../../src/server/auth/magic.js';
import { testDb, makeStudio } from '../helpers.js';

const T0 = 1_700_000_000_000;
async function fresh() { const db = await testDb(); const { studioId } = await makeStudio(db); return { studioId, sys: <T>(f: Parameters<typeof asSystem<T>>[1]) => asSystem(db, f) }; }

describe('magic links', () => {
  it('redeems once and yields a session in the link\'s Studio', async () => {
    const { studioId, sys } = await fresh(); const { token } = await sys((tx) => createMagicLink(tx, { kind: 'client', email: 'A@X', studioId, now: T0 }));
    const r = (await sys((tx) => redeemMagicLink(tx, token, T0 + 1000)))!;
    expect([r.session.kind, r.session.subject, r.session.studioId]).toEqual(['client', 'a@x', studioId]);
    expect(await sys((tx) => redeemMagicLink(tx, token, T0 + 2000))).toBeNull();          // single use
    expect((await sys((tx) => sessionFromToken(tx, r.sessionToken, T0 + 3000)))?.id).toBe(r.session.id);
    expect(await sys((tx) => sessionFromToken(tx, token, T0 + 3000))).toBeNull();          // login token is not a session token
  });
  it('expires client links after 30 days and admin links after 15 minutes', async () => {
    const { studioId, sys } = await fresh();
    const c = await sys((tx) => createMagicLink(tx, { kind: 'client', email: 'a@x', studioId, now: T0 }));
    const a = await sys((tx) => createMagicLink(tx, { kind: 'admin', email: 'o@x', studioId, now: T0 }));
    expect(await sys((tx) => redeemMagicLink(tx, c.token, T0 + TTL.client + 1))).toBeNull();
    expect(await sys((tx) => redeemMagicLink(tx, a.token, T0 + TTL.admin + 1))).toBeNull();
    const fresh2 = await sys((tx) => createMagicLink(tx, { kind: 'admin', email: 'o@x', studioId, now: T0 }));
    expect(await sys((tx) => redeemMagicLink(tx, fresh2.token, T0 + TTL.admin - 1))).not.toBeNull();
  });
  it('sessions expire and can be signed out', async () => {
    const { studioId, sys } = await fresh(); const { token } = await sys((tx) => createMagicLink(tx, { kind: 'client', email: 'a@x', studioId, now: T0 }));
    const { sessionToken } = (await sys((tx) => redeemMagicLink(tx, token, T0)))!;
    expect(await sys((tx) => sessionFromToken(tx, sessionToken, T0 + TTL.session + 1))).toBeNull();
    expect(await sys((tx) => sessionFromToken(tx, sessionToken, T0 + 1))).not.toBeNull();
    await sys((tx) => signOut(tx, sessionToken));
    expect(await sys((tx) => sessionFromToken(tx, sessionToken, T0 + 1))).toBeNull();
  });
  it('stores only hashes', async () => {
    const { studioId, sys } = await fresh(); const { token } = await sys((tx) => createMagicLink(tx, { kind: 'client', email: 'a@x', studioId, now: T0 }));
    const res = await sys((tx) => tx.execute<{ h: string }>(sql`select login_token_hash as h from sessions`));
    const [raw] = 'rows' in res ? res.rows : res;
    expect(raw!.h).not.toBe(token); expect(raw!.h).toHaveLength(64);
  });
});
