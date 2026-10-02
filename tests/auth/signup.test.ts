import { describe, it, expect } from 'vitest';
import { studios, users } from '../../src/server/db/schema.js';
import { asSystem } from '../../src/server/db/tenancy.js';
import { signup, sweepUnconfirmedStudios } from '../../src/server/auth/signup.js';
import { requestSignIn } from '../../src/server/auth/signin.js';
import { eq } from 'drizzle-orm';
import { testDb, makeStudio } from '../helpers.js';
import { boot } from '../http/boot.js';

const base = 'https://og.example';
type S = Awaited<ReturnType<typeof boot>>;
const me = async (s: S, cookie: string) => s.json<{ kind: string; studio: { id: string; name: string } }>(await s.api('/api/me', { cookie }));

describe('signup', () => {
  it('creates a Studio, its owner, and one sign-in email', async () => {
    const s = await boot();
    expect(await asSystem(s.db, (tx) => signup(tx, { email: 'New@X.com', studioName: 'Lumen', baseUrl: base }))).toEqual({ created: true });
    const [st] = await asSystem(s.db, (tx) => tx.select().from(studios));
    const us = await asSystem(s.db, (tx) => tx.select().from(users));
    expect(st!.name).toBe('Lumen'); expect(us.map((u) => [u.studioId, u.email, u.role])).toEqual([[st!.id, 'new@x.com', 'owner']]);
    await s.drain(); expect(s.mail.sent.map((m) => m.to)).toEqual(['new@x.com']);
    expect(await me(s, await s.redeemLatest('new@x.com'))).toMatchObject({ kind: 'admin', studio: { id: st!.id } });
  });
  it('signing up again sends a sign-in link and creates nothing', async () => {
    const s = await boot();
    await asSystem(s.db, (tx) => signup(tx, { email: 'new@x.com', studioName: 'Lumen', baseUrl: base }));
    expect(await asSystem(s.db, (tx) => signup(tx, { email: 'new@x.com', studioName: 'Other', baseUrl: base }))).toEqual({ created: false });
    expect(await asSystem(s.db, (tx) => tx.select().from(studios))).toHaveLength(1);
    await s.drain(); expect(s.mail.sent).toHaveLength(2);
  });
  it('a Team member of another Studio gets that Studio\'s sign-in link', async () => {
    const s = await boot(); const a = await makeStudio(s.db, { name: 'A', ownerEmail: 'm@x.com' });
    expect(await asSystem(s.db, (tx) => signup(tx, { email: 'm@x.com', studioName: 'Mine', baseUrl: base }))).toEqual({ created: false });
    expect(await asSystem(s.db, (tx) => tx.select().from(studios))).toHaveLength(1);
    await s.drain(); expect(s.mail.sent.map((m) => [m.to, m.fromName])).toEqual([['m@x.com', 'A']]);
    expect((await me(s, await s.redeemLatest('m@x.com'))).studio.id).toBe(a.studioId);
  });
});

describe('unconfirmed signups (final review)', () => {
  const studioRows = (db: Awaited<ReturnType<typeof testDb>>) => asSystem(db, (tx) => tx.select().from(studios));
  it('signup sends one link from Khroma; after confirming, links come from the Studio name', async () => {
    const s = await boot();
    await asSystem(s.db, (tx) => signup(tx, { email: 'o@x.com', studioName: 'Your Bank', baseUrl: base }));
    await s.drain();
    expect(s.mail.sent.map((m) => [m.fromName, m.subject, m.replyTo])).toEqual([['Khroma', 'Sign in to Khroma', 'o@x.com']]); // unconfirmed: the platform speaks
    expect((await me(s, await s.redeemLatest('o@x.com'))).studio.name).toBe('Your Bank');
    expect((await studioRows(s.db))[0]!.confirmedAt).not.toBeNull();
    await asSystem(s.db, (tx) => requestSignIn(tx, { email: 'o@x.com', baseUrl: base })); await s.drain();
    expect(s.mail.sent.map((m) => [m.fromName, m.subject])).toEqual([['Khroma', 'Sign in to Khroma'], ['Your Bank', 'Sign in to Your Bank']]);
  });
  it('signing up again before confirming takes the new name (the real owner reclaims a squatted email)', async () => {
    const db = await testDb();
    await asSystem(db, (tx) => signup(tx, { email: 'v@x.com', studioName: 'Squatter', baseUrl: base }));
    expect(await asSystem(db, (tx) => signup(tx, { email: 'v@x.com', studioName: 'Mine', baseUrl: base }))).toEqual({ created: false });
    expect((await studioRows(db)).map((s) => s.name)).toEqual(['Mine']);
  });
  it('a confirmed Studio keeps its name when someone signs up with its email', async () => {
    const db = await testDb(); await makeStudio(db, { name: 'Real', ownerEmail: 'o@x.com' });
    await asSystem(db, (tx) => signup(tx, { email: 'o@x.com', studioName: 'Hijack', baseUrl: base }));
    expect((await studioRows(db)).map((s) => s.name)).toEqual(['Real']);
  });
  it('unconfirmed Studios older than a day are swept, freeing the email', async () => {
    const db = await testDb(); await makeStudio(db, { name: 'Established' });
    await asSystem(db, (tx) => signup(tx, { email: 'v@x.com', studioName: 'Squatter', baseUrl: base }));
    expect(await sweepUnconfirmedStudios(db, Date.now() + 23 * 3600_000)).toBe(0);
    expect(await sweepUnconfirmedStudios(db, Date.now() + 25 * 3600_000)).toBe(1);
    expect((await studioRows(db)).map((s) => s.name)).toEqual(['Established']);
    expect(await asSystem(db, (tx) => tx.select().from(users).where(eq(users.email, 'v@x.com')))).toEqual([]);
  });
});
