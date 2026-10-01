import type { MiddlewareHandler } from 'hono';
import type { Db } from '../db/client.js';
import { asSystem } from '../db/tenancy.js';
import type { Storage } from '../storage.js';
import type { Auth } from '../auth/better.js';
import { tokenViewer } from '../domain/tokens.js';

/** Who is asking: a person signed in through Better Auth, or a bearer token. Always bound to one Studio. */
export type Viewer = { id: string; studioId: string; kind: 'admin' | 'client' | 'guest' | 'plugin' | 'mcp'; subject: string; projectId: string | null; scope: string; nickname: string | null };
/** `db` is the request's transaction (bound to the viewer's Studio); `root` is the pool, for system routes only. */
export type AppEnv = { Variables: { session: Viewer | null; db: Db; root: Db; storage: Storage } };

/**
 * `Authorization: Bearer ogp_…` for the Lightroom plugin (the lookup crosses Studios, so it runs as system); otherwise Better Auth's cookie.
 * A Better Auth session that /auth/continue never bound to a Studio is no session at all.
 */
export function sessionMiddleware(root: Db, auth: Auth): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('root', root); c.set('session', null);
    if (c.req.path.startsWith('/assets/')) return next(); // static files need no session
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(ogp_[A-Za-z0-9_-]+)$/)?.[1];
    if (bearer) c.set('session', await asSystem(root, (tx) => tokenViewer(tx, bearer)));
    else {
      const s = await auth.api.getSession({ headers: c.req.raw.headers });
      const kind = s?.session.kind;
      if (s?.session.studioId && (kind === 'admin' || kind === 'client'))
        c.set('session', { id: s.session.id, studioId: s.session.studioId, kind, subject: s.user.email.toLowerCase(), projectId: null, scope: 'read', nickname: null });
    }
    await next();
  };
}
