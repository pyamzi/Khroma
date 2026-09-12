import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, projects, photos, users } from '../db/schema.js';
import type { SessionRow } from '../auth/magic.js';
import type { AppEnv } from './session.js';

export type ProjectRow = typeof projects.$inferSelect;
export type PhotoRow = typeof photos.$inferSelect;
export type Access = 'ok' | 'forbidden';

export function isAdmin(db: Db, s: SessionRow | null): boolean {
  return !!s && s.kind === 'admin' && !!db.select({ id: users.id }).from(users).where(eq(users.email, s.subject)).get();
}
const servable = (p: ProjectRow) => p.available && !p.transferPending && p.archivedAt === null;

/** The one scoping rule. Every project-bound route goes through here; ownership is never read from the request. */
export function canAccessProject(db: Db, s: SessionRow | null, p: ProjectRow): Access {
  if (!s) return 'forbidden';
  if (s.kind === 'admin') return isAdmin(db, s) ? 'ok' : 'forbidden';
  if (!servable(p)) return 'forbidden';
  if (s.kind === 'client') {
    const c = db.select({ emails: clients.emails }).from(clients).where(eq(clients.id, p.clientId)).get();
    return c?.emails.some((e) => e.toLowerCase() === s.subject.toLowerCase()) ? 'ok' : 'forbidden';
  }
  if (s.kind === 'guest') return s.projectId === p.id ? 'ok' : 'forbidden';
  return 'forbidden'; // plugin / mcp tokens: milestones 4 and 10
}

export function listProjectsFor(db: Db, s: SessionRow | null): ProjectRow[] {
  return db.select().from(projects).all().filter((p) => canAccessProject(db, s, p) === 'ok');
}

export function requireKind(...kinds: SessionRow['kind'][]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get('session');
    if (!s || !kinds.includes(s.kind) || (s.kind === 'admin' && !isAdmin(c.get('db'), s))) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}

type WithProject = AppEnv & { Variables: { project: ProjectRow } };
type WithPhoto = WithProject & { Variables: { photo: PhotoRow } };

/** Forbidden and missing both answer 404 so existence is never leaked. */
export function loadProject(): MiddlewareHandler<WithProject> {
  return async (c, next) => {
    const db = c.get('db'); const p = db.select().from(projects).where(eq(projects.id, c.req.param('id') ?? '')).get();
    if (!p || canAccessProject(db, c.get('session'), p) !== 'ok') return c.json({ error: 'not found' }, 404);
    c.set('project', p); await next();
  };
}
export function loadPhoto(): MiddlewareHandler<WithPhoto> {
  return async (c, next) => {
    const db = c.get('db'); const ph = db.select().from(photos).where(eq(photos.id, c.req.param('photoId') ?? '')).get();
    const p = ph && db.select().from(projects).where(eq(projects.id, ph.projectId)).get();
    if (!ph || ph.missing || !p || canAccessProject(db, c.get('session'), p) !== 'ok') return c.json({ error: 'not found' }, 404);
    c.set('project', p); c.set('photo', ph); await next();
  };
}
