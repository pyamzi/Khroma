import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { requireKind, ownerOnly } from '../access.js';
import { fail } from '../errors.js';
import { users } from '../../db/schema.js';
import { getSetting } from '../../db/settings.js';
import type { Config } from '../../config.js';
import { StudioSettings, getStudio, setStudio, setEmailConfig, emailStatus, sendDeliveryTest, listUsers, inviteUser, updateUser, removeUser, listJobs, retryJobById } from '../../domain/settings.js';

const EmailBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('smtp'), url: z.string().url(), from: z.string().min(3) }),
  z.object({ type: z.literal('listmonk'), url: z.string().url(), token: z.string().min(1), from: z.string().min(3), templateId: z.number().int() }),
]);
const JobState = z.enum(['pending', 'running', 'done', 'failed', 'needs_review']);

export const settingsRoutes = (config: Config) => new Hono<AppEnv>()
  .get('/api/settings', requireKind('admin'), (c) => {
    const db = c.get('db');
    return c.json({ studio: getStudio(db), email: emailStatus(db, config), limits: getSetting(db, 'limits') ?? { attachmentBytes: 2 * 1024 ** 3, mediaBytes: 20 * 1024 ** 3 } });
  })
  .patch('/api/settings/studio', requireKind('admin'), ownerOnly(), async (c) => {
    const b = StudioSettings.partial().safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    return c.json(setStudio(c.get('db'), b.data, c.get('session')!.subject));
  })
  .put('/api/settings/email', requireKind('admin'), ownerOnly(), async (c) => {
    const b = EmailBody.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    setEmailConfig(c.get('db'), b.data, config.sessionSecret, c.get('session')!.subject); return c.json(emailStatus(c.get('db'), config));
  })
  .post('/api/settings/email/test', requireKind('admin'), (c) => c.json(sendDeliveryTest(c.get('db'), { to: c.get('session')!.subject, actor: c.get('session')!.subject })))
  .get('/api/users', requireKind('admin'), (c) => c.json(listUsers(c.get('db'))))
  .post('/api/users/invite', requireKind('admin'), ownerOnly(), async (c) => {
    const b = z.object({ email: z.string().email(), role: z.enum(['owner', 'member']).default('member') }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(inviteUser(c.get('db'), { ...b.data, actor: c.get('session')!.subject, baseUrl: config.baseUrl, studio: getStudio(c.get('db')).studioName }), 201); } catch (e) { return fail(c, e); }
  })
  .patch('/api/users/:id', requireKind('admin'), async (c) => {
    const b = z.object({ role: z.enum(['owner', 'member']).optional(), notifyDownloads: z.enum(['off', 'digest', 'each']).optional(), name: z.string().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const db = c.get('db'); const me = db.select().from(users).where(eq(users.email, c.get('session')!.subject)).get()!;
    const self = me.id === c.req.param('id');
    if (me.role !== 'owner' && !(self && Object.keys(b.data).every((k) => k === 'notifyDownloads' || k === 'name'))) return c.json({ error: 'forbidden' }, 403);
    try { return c.json(updateUser(db, { userId: c.req.param('id'), patch: b.data, actor: me.email })); } catch (e) { return fail(c, e); }
  })
  .delete('/api/users/:id', requireKind('admin'), ownerOnly(), (c) => {
    try { removeUser(c.get('db'), { userId: c.req.param('id'), actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .get('/api/jobs', requireKind('admin'), (c) => { const s = JobState.safeParse(c.req.query('state')); return c.json(listJobs(c.get('db'), { state: s.success ? s.data : undefined })); })
  .post('/api/jobs/:id/retry', requireKind('admin'), (c) => { try { return c.json(retryJobById(c.get('db'), c.req.param('id'))); } catch (e) { return fail(c, e); } });
