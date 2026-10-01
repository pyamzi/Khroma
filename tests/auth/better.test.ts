import { createHash } from 'node:crypto';
import { describe, it, expect, expectTypeOf } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { createAuth } from '../../src/server/auth/better.js';
import { continueUrl } from '../../src/server/auth/continue.js';
import { memoryTransport } from '../../src/server/email/transport.js';
import { authVerifications } from '../../src/server/db/schema.js';
import { testDb, makeStudio } from '../helpers.js';
import { boot } from '../http/boot.js';

async function authHarness() {
  const root = await testDb(); const { studioId } = await makeStudio(root); const mail = memoryTransport();
  const config = loadConfig({ DATABASE_URL: 'pglite://memory', BASE_URL: 'http://localhost:3000' });
  return { auth: createAuth({ root, config, getTransport: () => mail }), mail, root, studioId };
}
const meta = (studioId: string) => ({ studioId, kind: 'client' as const, fromName: 'Test Studio', replyTo: 'owner@x.com' });
const VERIFY = /http:\/\/localhost:3000\/api\/ba\/magic-link\/verify\?token=([^&\s]+)/;

describe('Better Auth instance', () => {
  it('signInMagicLink emails a verify link and stores only a hash', async () => {
    const { auth, mail, root, studioId } = await authHarness();
    await auth.api.signInMagicLink({ body: { email: 'a@x.com', callbackURL: '/auth/continue?x=1', metadata: meta(studioId) }, headers: new Headers() });
    const m = mail.sent.at(-1)!; const link = m.text.match(VERIFY)!;
    expect(m).toMatchObject({ to: 'a@x.com', fromName: 'Test Studio', replyTo: 'owner@x.com', subject: 'Sign in to Test Studio' });
    expect(m.messageId).toMatch(/^<magic:[\w-]+@localhost>$/);
    const rows = await root.select().from(authVerifications);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(link[1]!); // the raw token is in no column
    expect(rows[0]!.identifier).toBe(`magic-link:${createHash('sha256').update(link[1]!).digest('base64url')}`); // Better Auth's SHA-256 base64url hasher
  });

  it('a direct POST to Better Auth sign-in is not reachable', async () => {
    const s = await boot();
    expect((await s.api('/api/ba/sign-in/magic-link', { method: 'POST', body: JSON.stringify({ email: 'v@x.com' }) })).status).toBe(404); // x-requested-with is sent: the 404 is the missing route, not CSRF
    expect((await s.api('/api/ba/get-session')).status).toBe(404);
    expect(s.mail.sent).toHaveLength(0);
  });

  it('the verify link is served through the app and starts a session', async () => {
    const s = await boot(); const { studioId } = await makeStudio(s.db);
    await s.auth.api.signInMagicLink({ body: { email: 'a@x.com', callbackURL: continueUrl(s.config.betterAuthSecret, { studioId, kind: 'client', iat: Date.now() }), metadata: meta(studioId) }, headers: new Headers() });
    const res = await s.app.request(s.mail.sent.at(-1)!.text.match(/http\S+/)![0], { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/auth/continue');
    expect(res.headers.get('set-cookie')).toContain('og.session_token=');
  });

  it('sendMagicLink refuses calls without Studio metadata', async () => {
    const { auth, mail } = await authHarness();
    await expect(auth.api.signInMagicLink({ body: { email: 'a@x.com' }, headers: new Headers() })).rejects.toThrow();
    await expect(auth.api.signInMagicLink({ body: { email: 'a@x.com', metadata: { kind: 'client' } }, headers: new Headers() })).rejects.toThrow();
    expect(mail.sent).toHaveLength(0);
  });

  it('typings: session additionalFields reach getSession', async () => {
    const { auth } = await authHarness();
    type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>['session'];
    expectTypeOf<Session['studioId']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<Session['kind']>().toEqualTypeOf<string | null | undefined>();
  });
});
