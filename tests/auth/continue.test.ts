import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { continueUrl, verifyContinue } from '../../src/server/auth/continue.js';
import { authSessions, authVerifications, studios, clients } from '../../src/server/db/schema.js';
import { asSystem } from '../../src/server/db/tenancy.js';
import { newId } from '../../src/server/ids.js';
import { makeStudio } from '../helpers.js';
import { boot } from '../http/boot.js';

type S = Awaited<ReturnType<typeof boot>>;
const MIN = 60_000, DAY = 864e5;

/** Send a Better Auth link whose callback is a signed /auth/continue, follow verify, and return the Better Auth cookie and the continue URL. */
async function arrive(s: S, o: { email: string; studioId: string; kind: 'admin' | 'client'; age?: number; tamper?: (u: string) => string }) {
  const iat = Date.now() - (o.age ?? 0);
  await s.auth.api.signInMagicLink({ body: { email: o.email, callbackURL: continueUrl(s.config.betterAuthSecret, { studioId: o.studioId, kind: o.kind, iat }), metadata: { studioId: o.studioId, kind: o.kind, fromName: 'Test Studio', replyTo: null } }, headers: new Headers() });
  const verify = await s.app.request(s.mail.sent.at(-1)!.text.match(/http\S+/)![0], { redirect: 'manual' });
  const cookie = verify.headers.get('set-cookie')!.split(';')[0]!;
  return { cookie, location: o.tamper ? o.tamper(verify.headers.get('location')!) : verify.headers.get('location')! };
}
const follow = (s: S, a: { cookie: string; location: string }) => s.app.request(a.location, { redirect: 'manual', headers: { cookie: a.cookie } });
const session = (s: S, cookie: string) => s.auth.api.getSession({ headers: new Headers({ cookie }) });
const addClient = (s: S, studioId: string, email: string) => asSystem(s.db, (tx) => tx.insert(clients).values({ id: newId(), studioId, name: 'C', emails: [email] }));

describe('signed callback', () => {
  it('signs and verifies, and refuses a bad signature, kind, or age', () => {
    const q = (u: string) => Object.fromEntries(new URL(u, 'http://x').searchParams);
    const u = continueUrl('k', { studioId: 'A', kind: 'admin', iat: 1000 });
    expect(verifyContinue('k', q(u), 2000)).toEqual({ studioId: 'A', kind: 'admin' });
    expect(verifyContinue('other', q(u), 2000)).toBeNull();
    expect(verifyContinue('k', { ...q(u), kind: 'client' }, 2000)).toBeNull();
    expect(verifyContinue('k', { ...q(u), studio: 'B' }, 2000)).toBeNull();
    expect(verifyContinue('k', { ...q(u), sig: undefined }, 2000)).toBeNull();
    expect(verifyContinue('k', q(u), 1000 + 15 * MIN)).not.toBeNull();
    expect(verifyContinue('k', q(u), 1000 + 15 * MIN + 1)).toBeNull();
    const c = q(continueUrl('k', { studioId: 'A', kind: 'client', iat: 1000 }));
    expect(verifyContinue('k', c, 1000 + 29 * DAY)).not.toBeNull();
    expect(verifyContinue('k', c, 1000 + 30 * DAY + 1)).toBeNull();
  });
});

describe('GET /auth/continue', () => {
  it('a Client link signs in to that Studio as client', async () => {
    const s = await boot(); const { studioId } = await makeStudio(s.db); await addClient(s, studioId, 'c@x.com');
    const a = await arrive(s, { email: 'c@x.com', studioId, kind: 'client' });
    const res = await follow(s, a);
    expect(res.status).toBe(302); expect(res.headers.get('location')).toBe('/');
    expect(await session(s, a.cookie)).toMatchObject({ session: { studioId, kind: 'client' } });
  });

  it('a Team link older than 15 minutes is refused at verify and leaves no session', async () => {
    const s = await boot(); const { studioId } = await makeStudio(s.db, { ownerEmail: 'o@x.com' });
    await s.auth.api.signInMagicLink({ body: { email: 'o@x.com', callbackURL: continueUrl(s.config.betterAuthSecret, { studioId, kind: 'admin', iat: Date.now() - 16 * MIN }), metadata: { studioId, kind: 'admin', fromName: 'Test Studio', replyTo: null } }, headers: new Headers() });
    const res = await s.app.request(s.mail.sent.at(-1)!.text.match(/http\S+/)![0], { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/signin?error=expired');
    expect(await s.db.select().from(authSessions)).toHaveLength(0);
  });

  it('/auth/continue itself signs out a session whose callback fails, and clears the cookie', async () => {
    const s = await boot(); const { studioId } = await makeStudio(s.db, { ownerEmail: 'o@x.com' });
    const a = await arrive(s, { email: 'o@x.com', studioId, kind: 'admin', tamper: (u) => u.replace('kind=admin', 'kind=client') }); // fresh and signed at verify, then edited for /auth/continue
    const res = await follow(s, a);
    expect(res.headers.get('location')).toBe('/signin?error=expired');
    expect(await session(s, a.cookie)).toBeNull();
    expect(await s.db.select().from(authSessions)).toHaveLength(0);
    expect(res.headers.get('set-cookie')).toMatch(/og\.session_token=;/);
  });

  it('a Client link 29 days old still works', async () => {
    const s = await boot(); const { studioId } = await makeStudio(s.db); await addClient(s, studioId, 'c@x.com');
    const a = await arrive(s, { email: 'c@x.com', studioId, kind: 'client', age: 29 * DAY });
    expect((await follow(s, a)).headers.get('location')).toBe('/');
    expect((await session(s, a.cookie))?.session.kind).toBe('client');
  });

  it('a tampered studio or kind fails the signature', async () => {
    const s = await boot(); const A = await makeStudio(s.db, { ownerEmail: 'o@x.com' }); const B = await makeStudio(s.db);
    await addClient(s, A.studioId, 'o@x.com');
    for (const tamper of [(u: string) => u.replace(`studio=${A.studioId}`, `studio=${B.studioId}`), (u: string) => u.replace('kind=client', 'kind=admin')]) {
      const a = await arrive(s, { email: 'o@x.com', studioId: A.studioId, kind: 'client', tamper });
      const res = await follow(s, a);
      expect(res.headers.get('location')).toBe('/signin?error=expired');
      expect(await session(s, a.cookie)).toBeNull();
    }
  });

  it('one email, Team in A and Client in B: each link binds its own Studio', async () => {
    const s = await boot(); const A = await makeStudio(s.db, { ownerEmail: 'both@x.com' }); const B = await makeStudio(s.db); await addClient(s, B.studioId, 'both@x.com');
    const a = await arrive(s, { email: 'both@x.com', studioId: A.studioId, kind: 'admin' });
    const b = await arrive(s, { email: 'both@x.com', studioId: B.studioId, kind: 'client' });
    expect((await follow(s, a)).headers.get('location')).toBe('/');
    expect((await follow(s, b)).headers.get('location')).toBe('/');
    expect((await session(s, a.cookie))?.session).toMatchObject({ studioId: A.studioId, kind: 'admin' });
    expect((await session(s, b.cookie))?.session).toMatchObject({ studioId: B.studioId, kind: 'client' });
  });

  it('an email that is not a member of the named Studio is refused', async () => {
    const s = await boot(); await makeStudio(s.db, { ownerEmail: 'o@x.com' }); const B = await makeStudio(s.db);
    const a = await arrive(s, { email: 'o@x.com', studioId: B.studioId, kind: 'admin' }); // owner of A claims admin of B
    expect((await follow(s, a)).headers.get('location')).toBe('/signin?error=expired');
    expect(await session(s, a.cookie)).toBeNull();
  });

  it('a callback with no session goes to expired', async () => {
    const s = await boot(); const { studioId } = await makeStudio(s.db);
    const res = await s.app.request(continueUrl(s.config.betterAuthSecret, { studioId, kind: 'client', iat: Date.now() }), { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/signin?error=expired');
  });

  it('the first owner sign-in confirms the Studio', async () => {
    const s = await boot(); const { studioId } = await makeStudio(s.db, { ownerEmail: 'o@x.com' });
    await asSystem(s.db, (tx) => tx.update(studios).set({ confirmedAt: null }).where(eq(studios.id, studioId)));
    const a = await arrive(s, { email: 'o@x.com', studioId, kind: 'admin' });
    expect((await follow(s, a)).headers.get('location')).toBe('/');
    const [row] = await asSystem(s.db, (tx) => tx.select().from(studios).where(eq(studios.id, studioId)));
    expect(row!.confirmedAt).not.toBeNull();
  });

  describe('verify refuses links whose callback is not our signed, unexpired one', () => {
    const edit = async (edit: (u: URL) => void) => {
      const s = await boot(); const { studioId } = await makeStudio(s.db, { ownerEmail: 'o@x.com' });
      const iat = Date.now() - 16 * MIN;
      await s.auth.api.signInMagicLink({ body: { email: 'o@x.com', callbackURL: continueUrl(s.config.betterAuthSecret, { studioId, kind: 'admin', iat }), metadata: { studioId, kind: 'admin', fromName: 'Test Studio', replyTo: null } }, headers: new Headers() });
      const u = new URL(s.mail.sent.at(-1)!.text.match(/http\S+/)![0]); edit(u);
      const res = await s.app.request(u.pathname + u.search, { redirect: 'manual' });
      expect(res.status).toBe(302); expect(res.headers.get('location')).toBe('/signin?error=expired');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await s.db.select().from(authSessions)).toHaveLength(0);
      expect(await s.db.select().from(authVerifications)).toHaveLength(1); // the token was never consumed
    };
    it('an old Team link with callbackURL rewritten to /', () => edit((u) => u.searchParams.set('callbackURL', '/')));
    it('an old Team link with the callback removed', () => edit((u) => u.searchParams.delete('callbackURL')));
    it('a callback to /auth/continue with a bad signature', () => edit((u) => { const cb = new URL(u.searchParams.get('callbackURL')!, 'http://localhost:3000'); cb.searchParams.set('iat', String(Date.now())); u.searchParams.set('callbackURL', cb.pathname + cb.search); }));
    it('a cross-origin callback that reuses a valid signed query', () => edit((u) => { const cb = new URL(u.searchParams.get('callbackURL')!, 'http://localhost:3000'); u.searchParams.set('callbackURL', `https://evil.example${cb.pathname}${cb.search}`); }));
  });
});
