import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { requireKind, ownerOnly } from '../access.js';
import { fail } from '../errors.js';
import { users } from '../../db/schema.js';
import { getSetting } from '../../db/settings.js';
import type { Config } from '../../config.js';
import { StudioSettings, getStudio, setStudio, listUsers, inviteUser, updateUser, removeUser, listJobs, retryJobById } from '../../domain/settings.js';
import { createPluginToken, listPluginTokens, revokePluginToken, TokenError } from '../../domain/tokens.js';

const JobState = z.enum(['pending', 'running', 'done', 'failed', 'needs_review']);

export const settingsRoutes = (config: Config) => new Hono<AppEnv>()
  .get('/api/settings', requireKind('admin'), async (c) => {
    const db = c.get('db');
    return c.json({ studio: await getStudio(db), limits: (await getSetting(db, 'limits')) ?? { attachmentBytes: 2 * 1024 ** 3, mediaBytes: 20 * 1024 ** 3 } });
  })
  .patch('/api/settings/studio', requireKind('admin'), ownerOnly(), async (c) => {
    const b = StudioSettings.partial().safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    return c.json(await setStudio(c.get('db'), b.data, c.get('session')!.subject));
  })
  .get('/api/users', requireKind('admin'), async (c) => c.json(await listUsers(c.get('db'))))
  .post('/api/users/invite', requireKind('admin'), ownerOnly(), async (c) => {
    const b = z.object({ email: z.string().email(), role: z.enum(['owner', 'member']).default('member') }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await inviteUser(c.get('db'), { ...b.data, actor: c.get('session')!.subject, baseUrl: config.baseUrl }), 201); } catch (e) { return fail(c, e); }
  })
  .patch('/api/users/:id', requireKind('admin'), async (c) => {
    const b = z.object({ role: z.enum(['owner', 'member']).optional(), notifyDownloads: z.enum(['off', 'digest', 'each']).optional(), name: z.string().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const db = c.get('db'); const [me] = await db.select().from(users).where(eq(users.email, c.get('session')!.subject)).limit(1);
    const self = me!.id === c.req.param('id');
    if (me!.role !== 'owner' && !(self && Object.keys(b.data).every((k) => k === 'notifyDownloads' || k === 'name'))) return c.json({ error: 'forbidden' }, 403);
    try { return c.json(await updateUser(db, { userId: c.req.param('id'), patch: b.data, actor: me!.email })); } catch (e) { return fail(c, e); }
  })
  .delete('/api/users/:id', requireKind('admin'), ownerOnly(), async (c) => {
    try { await removeUser(c.get('db'), { userId: c.req.param('id'), actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .get('/api/access/tokens', requireKind('admin'), async (c) => c.json(await listPluginTokens(c.get('db'))))
  .post('/api/access/tokens', requireKind('admin'), async (c) => {
    const b = z.object({ name: z.string().min(1).max(80), scope: z.enum(['read', 'read+write']).default('read+write'), projectId: z.string().nullable().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await createPluginToken(c.get('db'), { name: b.data.name, scope: b.data.scope, projectId: b.data.projectId ?? null, actor: c.get('session')!.subject }), 201); }
    catch (e) { if (e instanceof TokenError) return c.json({ error: e.code }, e.code === 'not_found' ? 404 : 400); throw e; }
  })
  .delete('/api/access/tokens/:id', requireKind('admin'), async (c) => {
    try { await revokePluginToken(c.get('db'), { id: c.req.param('id'), actor: c.get('session')!.subject }); return c.json({ ok: true }); }
    catch (e) { if (e instanceof TokenError) return c.json({ error: e.code }, 404); throw e; }
  })
  .get('/api/jobs', requireKind('admin'), async (c) => { const s = JobState.safeParse(c.req.query('state')); return c.json(await listJobs(c.get('db'), { state: s.success ? s.data : undefined })); })
  .post('/api/jobs/:id/retry', requireKind('admin'), async (c) => { try { return c.json(await retryJobById(c.get('db'), c.req.param('id'))); } catch (e) { return fail(c, e); } });
