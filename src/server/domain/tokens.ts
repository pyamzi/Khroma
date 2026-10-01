import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, events, projects } from '../db/schema.js';
import { hashToken, randomToken } from '../auth/magic.js';
import { newId } from '../ids.js';
import type { Viewer } from '../http/session.js';

export type TokenScope = 'read' | 'read+write';
export class TokenError extends Error { constructor(public code: 'invalid' | 'not_found') { super(code); this.name = 'TokenError'; } }
const YEAR = 365 * 864e5;

/** The raw token is returned once and never stored; only its hash is. The token belongs to the current Studio. */
export async function createPluginToken(db: Db, o: { name: string; scope: TokenScope; projectId?: string | null; actor: string }): Promise<{ id: string; token: string }> {
  const name = o.name.trim(); if (!name || name.length > 80) throw new TokenError('invalid');
  if (o.projectId && !(await db.select({ id: projects.id }).from(projects).where(eq(projects.id, o.projectId)).limit(1)).length) throw new TokenError('not_found');
  const token = `ogp_${randomToken()}`; const id = newId();
  await db.insert(sessions).values({ id, kind: 'plugin', subject: o.actor.toLowerCase(), nickname: name, scope: o.scope, projectId: o.projectId ?? null, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + YEAR).toISOString() });
  await db.insert(events).values({ actor: o.actor, type: 'token_created', payload: { id, name, scope: o.scope, projectId: o.projectId ?? null } });
  return { id, token };
}

/** The viewer a bearer token stands for, if it is live. Looked up before any Studio is known, so `db` is a system transaction. */
export async function tokenViewer(db: Db, token: string, now = Date.now()): Promise<Viewer | null> {
  const [r] = await db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token))).limit(1);
  return r && Date.parse(r.expiresAt) > now ? { id: r.id, studioId: r.studioId, kind: r.kind, subject: r.subject, projectId: r.projectId, scope: r.scope, nickname: r.nickname } : null;
}

export async function listPluginTokens(db: Db) {
  return (await db.select().from(sessions).where(and(eq(sessions.kind, 'plugin'), isNotNull(sessions.tokenHash))))
    .map((s) => ({ id: s.id, name: s.nickname ?? '', scope: s.scope as TokenScope, projectId: s.projectId, createdBy: s.subject, createdAt: s.createdAt, expiresAt: s.expiresAt }));
}

export async function revokePluginToken(db: Db, o: { id: string; actor: string }): Promise<void> {
  const [row] = await db.select().from(sessions).where(and(eq(sessions.id, o.id), eq(sessions.kind, 'plugin'))).limit(1);
  if (!row || !row.tokenHash) throw new TokenError('not_found');
  await db.update(sessions).set({ tokenHash: null, expiresAt: new Date(0).toISOString() }).where(eq(sessions.id, o.id));
  await db.insert(events).values({ actor: o.actor, type: 'token_revoked', payload: { id: o.id, name: row.nickname } });
}
