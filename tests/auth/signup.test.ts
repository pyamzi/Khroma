import { describe, it, expect } from 'vitest';
import { studios, users } from '../../src/server/db/schema.js';
import { asSystem } from '../../src/server/db/tenancy.js';
import { signup } from '../../src/server/auth/signup.js';
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
