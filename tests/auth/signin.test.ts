import { describe, it, expect } from 'vitest';
import { clients, jobs } from '../../src/server/db/schema.js';
import { asSystem, withStudio } from '../../src/server/db/tenancy.js';
import { requestSignIn } from '../../src/server/auth/signin.js';
import { redeemMagicLink } from '../../src/server/auth/magic.js';
import { testDb, makeStudio } from '../helpers.js';
import { queuedMail } from './mail.js';

const base = 'https://og.example';

describe('sign-in across Studios', () => {
  it('one email, owner in A and client in B: two links, each session in its own Studio', async () => {
    const db = await testDb(); const a = await makeStudio(db, { name: 'A Studio', ownerEmail: 'sam@x.com' }); const b = await makeStudio(db, { name: 'B Studio' });
    await withStudio(db, b.studioId, (tx) => tx.insert(clients).values({ id: 'cb', name: 'Sam', emails: ['sam@x.com'] }));
    expect(await asSystem(db, (tx) => requestSignIn(tx, { email: 'Sam@X.com', baseUrl: base }))).toBe(2);
    const mail = await queuedMail(db);
    expect(mail.map((m) => [m.studioId, m.to, m.vars.studio]).sort()).toEqual([[a.studioId, 'sam@x.com', 'A Studio'], [b.studioId, 'sam@x.com', 'B Studio']].sort());
    const sessions = await Promise.all(mail.map((m) => asSystem(db, (tx) => redeemMagicLink(tx, m.token!))));
    expect(sessions.map((s) => [s!.session.studioId, s!.session.kind]).sort()).toEqual([[a.studioId, 'admin'], [b.studioId, 'client']].sort());
  });
  it('an unknown email gets nothing', async () => {
    const db = await testDb(); await makeStudio(db);
    expect(await asSystem(db, (tx) => requestSignIn(tx, { email: 'nobody@x.com', baseUrl: base }))).toBe(0);
    expect(await queuedMail(db)).toEqual([]);
  });
  it('an owner who is also a client in the same Studio gets one admin link', async () => {
    const db = await testDb(); const a = await makeStudio(db, { ownerEmail: 'o@x.com' });
    await withStudio(db, a.studioId, (tx) => tx.insert(clients).values({ id: 'c', name: 'O', emails: ['o@x.com'] }));
    expect(await asSystem(db, (tx) => requestSignIn(tx, { email: 'o@x.com', baseUrl: base }))).toBe(1);
    const [m] = await queuedMail(db);
    expect((await asSystem(db, (tx) => redeemMagicLink(tx, m!.token!)))!.session.kind).toBe('admin');
  });
});

describe('sign-in tokens at rest', () => {
  it('a queued sign-in email holds no token; the link is minted when the email is sent', async () => {
    const db = await testDb(); await makeStudio(db, { ownerEmail: 'o@x.com' });
    await asSystem(db, (tx) => requestSignIn(tx, { email: 'o@x.com', baseUrl: base }));
    const [job] = await asSystem(db, (tx) => tx.select().from(jobs));
    expect(JSON.stringify(job!.payload)).not.toMatch(/\/auth\//);
    const [m] = await queuedMail(db);
    expect((await asSystem(db, (tx) => redeemMagicLink(tx, m!.token!)))!.session.kind).toBe('admin');
  });
});
