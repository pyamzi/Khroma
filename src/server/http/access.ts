import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, projects, photos, users } from '../db/schema.js';
import type { AppEnv, Viewer } from './session.js';

export type ProjectRow = typeof projects.$inferSelect;
export type PhotoRow = typeof photos.$inferSelect;
export type Access = 'ok' | 'forbidden';

/** `db` is the request transaction, so users are already the session's Studio. */
export async function isAdmin(db: Db, s: Viewer | null): Promise<boolean> {
  return !!s && s.kind === 'admin' && (await db.select({ id: users.id }).from(users).where(eq(users.email, s.subject)).limit(1)).length > 0;
}
const servable = (p: ProjectRow) => p.archivedAt === null;

/** The one scoping rule. Every project-bound route goes through here; ownership is never read from the request. Row-level security is the backstop. */
export async function canAccessProject(db: Db, s: Viewer | null, p: ProjectRow): Promise<Access> {
  if (!s || s.studioId !== p.studioId) return 'forbidden';
  if (s.kind === 'admin') return (await isAdmin(db, s)) ? 'ok' : 'forbidden';
  if (!servable(p)) return 'forbidden';
  if (s.kind === 'client') {
    const [c] = await db.select({ emails: clients.emails }).from(clients).where(eq(clients.id, p.clientId)).limit(1);
    return c?.emails.some((e) => e.toLowerCase() === s.subject.toLowerCase()) ? 'ok' : 'forbidden';
  }
  if (s.kind === 'guest') return s.projectId === p.id ? 'ok' : 'forbidden';
  if (s.kind === 'plugin') return !s.projectId || s.projectId === p.id ? 'ok' : 'forbidden';
  return 'forbidden'; // mcp tokens: H4
}

export async function listProjectsFor(db: Db, s: Viewer | null): Promise<ProjectRow[]> {
  if (!s) return [];
  const out: ProjectRow[] = [];
  for (const p of await db.select().from(projects)) if ((await canAccessProject(db, s, p)) === 'ok') out.push(p);
  return out;
}

/** Mutating plugin routes need a read+write token. */
export function requireScope(scope: 'write'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get('session');
    if (!s || (scope === 'write' && !s.scope.includes('write'))) return c.json({ error: 'read_only' }, 403);
    await next();
  };
}
export function requireKind(...kinds: Viewer['kind'][]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get('session');
    if (!s || !kinds.includes(s.kind) || (s.kind === 'admin' && !(await isAdmin(c.get('db'), s)))) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}

type WithProject = AppEnv & { Variables: { project: ProjectRow } };
type WithPhoto = AppEnv & { Variables: { project: ProjectRow | null; photo: PhotoRow } };

/** Forbidden and missing both answer 404 so existence is never leaked. */
export function loadProject(): MiddlewareHandler<WithProject> {
  return async (c, next) => {
    const db = c.get('db'); const [p] = await db.select().from(projects).where(eq(projects.id, c.req.param('id') ?? '')).limit(1);
    if (!p || (await canAccessProject(db, c.get('session'), p)) !== 'ok') return c.json({ error: 'not found' }, 404);
    c.set('project', p); await next();
  };
}
export function loadPhoto(): MiddlewareHandler<WithPhoto> {
  return async (c, next) => {
    const db = c.get('db'); const [ph] = await db.select().from(photos).where(eq(photos.id, c.req.param('photoId') ?? '')).limit(1);
    if (!ph) return c.json({ error: 'not found' }, 404);
    let p: ProjectRow | null = null;
    if (ph.projectId === null) { // a Library photo belongs to its Studio: only that Studio's admin reaches it
      const s = c.get('session');
      if (!s || s.kind !== 'admin' || s.studioId !== ph.studioId || !(await isAdmin(db, s))) return c.json({ error: 'not found' }, 404);
    } else {
      [p = null] = await db.select().from(projects).where(eq(projects.id, ph.projectId)).limit(1);
      if (!p || (await canAccessProject(db, c.get('session'), p)) !== 'ok') return c.json({ error: 'not found' }, 404);
    }
    c.set('project', p); c.set('photo', ph); await next();
  };
}

export function ownerOnly(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get('session'); const [u] = s ? await c.get('db').select().from(users).where(eq(users.email, s.subject)).limit(1) : [];
    if (!u || u.role !== 'owner') return c.json({ error: 'forbidden' }, 403);
    await next();
  };
}
