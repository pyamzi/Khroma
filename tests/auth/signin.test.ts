import { describe, it, expect } from 'vitest';
import { clients, jobs } from '../../src/server/db/schema.js';
import { asSystem, withStudio } from '../../src/server/db/tenancy.js';
import { requestSignIn } from '../../src/server/auth/signin.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { makeStudio } from '../helpers.js';
import { boot } from '../http/boot.js';

type S = Awaited<ReturnType<typeof boot>>;
const request = (s: S, email: string) => asSystem(s.db, (tx) => requestSignIn(tx, { email, baseUrl: s.config.baseUrl }));
const me = async (s: S, cookie: string) => s.json<{ kind: string; studio: { id: string } }>(await s.api('/api/me', { cookie }));

describe('sign-in across Studios', () => {
  it('one email, owner in A and client in B: two links, each session in its own Studio', async () => {
    const s = await boot(); const a = await makeStudio(s.db, { name: 'A Studio', ownerEmail: 'sam@x.com' }); const b = await makeStudio(s.db, { name: 'B Studio' });
    await withStudio(s.db, b.studioId, (tx) => tx.insert(clients).values({ id: 'cb', name: 'Sam', emails: ['sam@x.com'] }));
    expect(await request(s, 'Sam@X.com')).toBe(2);
    await s.drain();
    expect(s.mail.sent.map((m) => [m.to, m.fromName, m.subject]).sort()).toEqual([['sam@x.com', 'A Studio', 'Sign in to A Studio'], ['sam@x.com', 'B Studio', 'Sign in to B Studio']]);
    expect(await me(s, await s.redeemLatest('sam@x.com', 'A Studio'))).toMatchObject({ kind: 'admin', studio: { id: a.studioId } });
    expect(await me(s, await s.redeemLatest('sam@x.com', 'B Studio'))).toMatchObject({ kind: 'client', studio: { id: b.studioId } });
  });
  it('an unknown email gets nothing', async () => {
    const s = await boot(); await makeStudio(s.db);
    expect(await request(s, 'nobody@x.com')).toBe(0);
    await s.drain(); expect(s.mail.sent).toEqual([]);
  });
  it('an owner who is also a client in the same Studio gets one admin link', async () => {
    const s = await boot(); const a = await makeStudio(s.db, { ownerEmail: 'o@x.com' });
    await withStudio(s.db, a.studioId, (tx) => tx.insert(clients).values({ id: 'c', name: 'O', emails: ['o@x.com'] }));
    expect(await request(s, 'o@x.com')).toBe(1);
    await s.drain(); expect(s.mail.sent).toHaveLength(1);
    expect((await me(s, await s.redeemLatest('o@x.com'))).kind).toBe('admin');
  });
  it('the email comes from the Studio, with its first owner as reply-to', async () => {
    const s = await boot(); await makeStudio(s.db, { name: 'Lumen', ownerEmail: 'own@x.com' });
    await request(s, 'own@x.com'); await s.drain();
    expect(s.mail.sent[0]).toMatchObject({ to: 'own@x.com', fromName: 'Lumen', replyTo: 'own@x.com' });
  });
});

describe('sign-in tokens at rest', () => {
  it('no sign-in link or token is ever stored in jobs', async () => {
    const s = await boot(); await makeStudio(s.db, { ownerEmail: 'o@x.com' });
    await request(s, 'o@x.com');
    const clean = async () => { for (const j of await asSystem(s.db, (tx) => tx.select().from(jobs))) expect(JSON.stringify(j.payload)).not.toMatch(/token|magic-link\/verify/i); };
    await clean(); await s.drain(); await clean();
    expect(s.mail.sent).toHaveLength(1); expect((await me(s, await s.redeemLatest('o@x.com'))).kind).toBe('admin');
  });
  it('a transport failure retries the job and the next attempt sends a fresh working link', async () => {
    const s = await boot(); await makeStudio(s.db, { ownerEmail: 'o@x.com' });
    const send = s.mail.send; s.mail.send = async () => { throw new Error('smtp down'); };
    await request(s, 'o@x.com'); await s.drain();
    const [failed] = await asSystem(s.db, (tx) => tx.select().from(jobs));
    expect(failed).toMatchObject({ kind: 'send_magic_link', state: 'pending', attempts: 1 }); expect(failed!.lastError).toMatch(/smtp down/);
    s.mail.send = send;
    expect(await runOnce(s.db, s.handlers, failed!.nextAt)).toBe('ran');
    expect((await asSystem(s.db, (tx) => tx.select().from(jobs)))[0]).toMatchObject({ state: 'done', attempts: 2 });
    expect(s.mail.sent).toHaveLength(1);
    expect((await me(s, await s.redeemLatest('o@x.com'))).kind).toBe('admin');
  });
});
