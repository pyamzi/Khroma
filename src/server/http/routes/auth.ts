import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { setSessionCookie, clearSessionCookie } from '../session.js';
import { isAdmin } from '../access.js';
import { createMagicLink, redeemMagicLink, signOut } from '../../auth/magic.js';
import { setupState, markSetupComplete } from '../../auth/bootstrap.js';
import { sendEmail } from '../../email/send.js';
import { getSetting } from '../../db/settings.js';
import { users, clients } from '../../db/schema.js';
import type { Config } from '../../config.js';

// ponytail: in-process rate limit; the NAS runs one app process. Move to sqlite if a second process ever appears.
const hits = new Map<string, number[]>();
export function limited(key: string, max: number, now = Date.now(), windowMs = 15 * 60_000): boolean {
  const arr = (hits.get(key) ?? []).filter((t) => t > now - windowMs); arr.push(now); hits.set(key, arr);
  return arr.length > max;
}

export const auth = (config: Config) => new Hono<AppEnv>()
  .post('/api/auth/request', async (c) => {
    const b = z.object({ email: z.string().email() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const email = b.data.email.toLowerCase();
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local';
    // always 200: no account enumeration, and a limited caller learns nothing either
    if (limited(`e:${email}`, 5) || limited(`ip:${ip}`, 20)) return c.json({ ok: true });
    const db = c.get('db'); const studio = getSetting<string>(db, 'studioName') ?? 'OpenGallery';
    const isUser = !!db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    const isClient = db.select({ emails: clients.emails }).from(clients).all().some((r) => r.emails.some((e) => e.toLowerCase() === email));
    const kind = isUser ? 'admin' : isClient ? 'client' : null;
    if (kind) {
      const link = createMagicLink(db, { kind, email });
      sendEmail(db, { to: email, template: 'magic_link', vars: { studio, url: `${config.baseUrl}/auth/${link.token}` }, key: `magic:${email}:${Date.now()}` });
    }
    return c.json({ ok: true });
  })
  .get('/auth/:token', (c) => {
    const db = c.get('db'); const r = redeemMagicLink(db, c.req.param('token'));
    if (!r) return c.redirect('/signin?error=expired');
    if (r.session.kind === 'admin' && setupState(db) === 'awaiting_verification') markSetupComplete(db);
    setSessionCookie(c, r.sessionToken, config.secureCookies);
    return c.redirect('/');
  })
  .post('/api/auth/signout', (c) => {
    const t = c.get('sessionToken'); if (t) signOut(c.get('db'), t);
    clearSessionCookie(c); return c.json({ ok: true });
  })
  .get('/api/me', (c) => {
    const s = c.get('session'); if (!s) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ kind: s.kind, subject: s.subject, isAdmin: isAdmin(c.get('db'), s), projectId: s.projectId });
  });
