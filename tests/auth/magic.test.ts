import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { createMagicLink, redeemMagicLink, sessionFromToken, signOut, TTL } from '../../src/server/auth/magic.js';

const T0 = 1_700_000_000_000;
function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

describe('magic links', () => {
  it('redeems once and yields a session', () => {
    const db = fresh(); const { token } = createMagicLink(db, { kind: 'client', email: 'A@X', now: T0 });
    const r = redeemMagicLink(db, token, T0 + 1000)!;
    expect(r.session.kind).toBe('client'); expect(r.session.subject).toBe('a@x');
    expect(redeemMagicLink(db, token, T0 + 2000)).toBeNull();          // single use
    expect(sessionFromToken(db, r.sessionToken, T0 + 3000)?.id).toBe(r.session.id);
    expect(sessionFromToken(db, token, T0 + 3000)).toBeNull();          // login token is not a session token
  });
  it('expires client links after 30 days and admin links after 15 minutes', () => {
    const db = fresh();
    const c = createMagicLink(db, { kind: 'client', email: 'a@x', now: T0 });
    const a = createMagicLink(db, { kind: 'admin', email: 'o@x', now: T0 });
    expect(redeemMagicLink(db, c.token, T0 + TTL.client + 1)).toBeNull();
    expect(redeemMagicLink(db, a.token, T0 + TTL.admin + 1)).toBeNull();
    expect(redeemMagicLink(db, createMagicLink(db, { kind: 'admin', email: 'o@x', now: T0 }).token, T0 + TTL.admin - 1)).not.toBeNull();
  });
  it('sessions expire and can be signed out', () => {
    const db = fresh(); const { token } = createMagicLink(db, { kind: 'client', email: 'a@x', now: T0 });
    const { sessionToken } = redeemMagicLink(db, token, T0)!;
    expect(sessionFromToken(db, sessionToken, T0 + TTL.session + 1)).toBeNull();
    expect(sessionFromToken(db, sessionToken, T0 + 1)).not.toBeNull();
    signOut(db, sessionToken);
    expect(sessionFromToken(db, sessionToken, T0 + 1)).toBeNull();
  });
  it('stores only hashes', () => {
    const db = fresh(); const { token } = createMagicLink(db, { kind: 'client', email: 'a@x', now: T0 });
    const raw = db.$client.prepare('select login_token_hash from sessions').get() as { login_token_hash: string };
    expect(raw.login_token_hash).not.toBe(token); expect(raw.login_token_hash).toHaveLength(64);
  });
});
