import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv } from '../session.js';
import { loadProject, requireKind } from '../access.js';
import { setPick, summary, currentPicks, grantSlots, setIncluded, Conflict, SelectionError } from '../../domain/selection.js';
import { finishRound, cancelRound, requestExtras, TransitionError } from '../../domain/transitions.js';
import type { Config } from '../../config.js';

const Pick = z.object({ photoId: z.string().min(1), picked: z.boolean(), selectionVersion: z.number().int() });
const Finish = z.object({ selectionVersion: z.number().int() });
const Extras = z.object({ count: z.number().int().min(1).max(500) });
const Grant = z.object({ delta: z.number().int().min(-1000).max(1000), reason: z.enum(['gift', 'release']).default('gift') });
const Allowance = z.object({ included: z.number().int().min(0).max(100000) });

function fail(c: Context, e: unknown): Response {
  if (e instanceof Conflict) return c.json({ error: 'conflict', selectionVersion: e.selectionVersion }, 409);
  if (e instanceof SelectionError || e instanceof TransitionError) return c.json({ error: e.code }, 422);
  throw e;
}
async function parse<S extends z.ZodTypeAny>(c: Context, s: S): Promise<z.output<S> | null> { const b = s.safeParse(await c.req.json().catch(() => null)); return b.success ? (b.data as z.output<S>) : null; }

export const selectionRoutes = (config: Config, photosDir: string) => new Hono<AppEnv>()
  .get('/api/projects/:id/selection', loadProject(), (c) => {
    const db = c.get('db'); const p = c.get('project');
    return c.json({ summary: summary(db, p.id), picks: currentPicks(db, p.id) });
  })
  .post('/api/projects/:id/picks', loadProject(), async (c) => {
    const b = await parse(c, Pick); if (!b) return c.json({ error: 'invalid body' }, 400);
    const db = c.get('db'); const p = c.get('project'); const s = c.get('session')!;
    try { const sum = setPick(db, { projectId: p.id, photoId: b.photoId, picked: b.picked, byEmail: s.subject, expectedVersion: b.selectionVersion }); return c.json({ summary: sum, picks: currentPicks(db, p.id) }); }
    catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/finish', loadProject(), async (c) => {
    const b = await parse(c, Finish); if (!b) return c.json({ error: 'invalid body' }, 400);
    try { const r = await finishRound(c.get('db'), photosDir, { projectId: c.get('project').id, actor: c.get('session')!.subject, expectedVersion: b.selectionVersion, baseUrl: config.baseUrl }); return c.json({ round: r.round, count: r.photoIds.length }); }
    catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/extras-request', requireKind('client'), loadProject(), async (c) => {
    const b = await parse(c, Extras); if (!b) return c.json({ error: 'invalid body' }, 400);
    requestExtras(c.get('db'), { projectId: c.get('project').id, count: b.count, byEmail: c.get('session')!.subject, baseUrl: config.baseUrl });
    return c.json({ ok: true });
  })
  .post('/api/projects/:id/grant', requireKind('admin'), loadProject(), async (c) => {
    const b = await parse(c, Grant); if (!b) return c.json({ error: 'invalid body' }, 400);
    return c.json(await grantSlots(c.get('db'), photosDir, { projectId: c.get('project').id, delta: b.delta, reason: b.reason, actor: c.get('session')!.subject }));
  })
  .post('/api/projects/:id/allowance', requireKind('admin'), loadProject(), async (c) => {
    const b = await parse(c, Allowance); if (!b) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await setIncluded(c.get('db'), photosDir, { projectId: c.get('project').id, included: b.included, actor: c.get('session')!.subject })); }
    catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/cancel-round', requireKind('admin'), loadProject(), async (c) => {
    await cancelRound(c.get('db'), photosDir, { projectId: c.get('project').id, actor: c.get('session')!.subject });
    return c.json({ ok: true });
  });
