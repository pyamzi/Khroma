import { describe, it, expect } from 'vitest';
import { studios, users } from '../../src/server/db/schema.js';
import { asSystem } from '../../src/server/db/tenancy.js';
import { signup, sweepUnconfirmedStudios } from '../../src/server/auth/signup.js';
import { requestSignIn } from '../../src/server/auth/signin.js';
import { eq } from 'drizzle-orm';
import { redeemMagicLink } from '../../src/server/auth/magic.js';
import { testDb, makeStudio } from '../helpers.js';
import { queuedMail } from './mail.js';

const base = 'https://og.example';

describe('signup', () => {
  it('creates a Studio, its owner, and one sign-in email', async () => {
    const db = await testDb();
    expect(await asSystem(db, (tx) => signup(tx, { email: 'New@X.com', studioName: 'Lumen', baseUrl: base }))).toEqual({ created: true });
    const [s] = await asSystem(db, (tx) => tx.select().from(studios));
    const us = await asSystem(db, (tx) => tx.select().from(users));
    expect(s!.name).toBe('Lumen'); expect(us.map((u) => [u.studioId, u.email, u.role])).toEqual([[s!.id, 'new@x.com', 'owner']]);
    const mail = await queuedMail(db);
    expect(mail.map((m) => [m.studioId, m.to])).toEqual([[s!.id, 'new@x.com']]);
    const r = await asSystem(db, (tx) => redeemMagicLink(tx, mail[0]!.token!));
    expect([r!.session.kind, r!.session.studioId]).toEqual(['admin', s!.id]);
  });
  it('signing up again sends a sign-in link and creates nothing', async () => {
    const db = await testDb();
    await asSystem(db, (tx) => signup(tx, { email: 'new@x.com', studioName: 'Lumen', baseUrl: base }));
    expect(await asSystem(db, (tx) => signup(tx, { email: 'new@x.com', studioName: 'Other', baseUrl: base }))).toEqual({ created: false });
    expect(await asSystem(db, (tx) => tx.select().from(studios))).toHaveLength(1);
    expect(await queuedMail(db)).toHaveLength(2);
  });
  it('a Team member of another Studio gets that Studio\'s sign-in link', async () => {
    const db = await testDb(); const a = await makeStudio(db, { name: 'A', ownerEmail: 'm@x.com' });
    expect(await asSystem(db, (tx) => signup(tx, { email: 'm@x.com', studioName: 'Mine', baseUrl: base }))).toEqual({ created: false });
    expect(await asSystem(db, (tx) => tx.select().from(studios))).toHaveLength(1);
    const mail = await queuedMail(db);
    expect(mail.map((m) => [m.studioId, m.to])).toEqual([[a.studioId, 'm@x.com']]);
  });
});

describe('unconfirmed signups (final review)', () => {
  const studioRows = (db: Awaited<ReturnType<typeof testDb>>) => asSystem(db, (tx) => tx.select().from(studios));
  it('an unconfirmed Studio emails as the platform, not under its chosen name', async () => {
    const db = await testDb();
    await asSystem(db, (tx) => signup(tx, { email: 'v@x.com', studioName: 'Your Bank', baseUrl: base }));
    const [m] = await queuedMail(db);
    expect([m!.fromName, m!.vars.studio]).toEqual(['OpenGallery', 'OpenGallery']);
  });
  it('the owner\'s first sign-in confirms the Studio; later emails carry its name', async () => {
    const db = await testDb();
    await asSystem(db, (tx) => signup(tx, { email: 'o@x.com', studioName: 'Lumen', baseUrl: base }));
    const [m] = await queuedMail(db);
    await asSystem(db, (tx) => redeemMagicLink(tx, m!.token!));
    expect((await studioRows(db))[0]!.confirmedAt).not.toBeNull();
    await asSystem(db, (tx) => requestSignIn(tx, { email: 'o@x.com', baseUrl: base }));
    expect((await queuedMail(db)).at(-1)!.fromName).toBe('Lumen');
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
