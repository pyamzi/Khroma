import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, events, projects } from '../db/schema.js';
import { hashToken, randomToken } from '../auth/magic.js';
import { newId } from '../fs/ids.js';

export type TokenScope = 'read' | 'read+write';
export class TokenError extends Error { constructor(public code: 'invalid' | 'not_found') { super(code); this.name = 'TokenError'; } }
const YEAR = 365 * 864e5;

/** The raw token is returned once and never stored; only its hash is. */
export function createPluginToken(db: Db, o: { name: string; scope: TokenScope; projectId?: string | null; actor: string }): { id: string; token: string } {
  const name = o.name.trim(); if (!name || name.length > 80) throw new TokenError('invalid');
  if (o.projectId && !db.select({ id: projects.id }).from(projects).where(eq(projects.id, o.projectId)).get()) throw new TokenError('not_found');
  const token = `ogp_${randomToken()}`; const id = newId();
  db.insert(sessions).values({ id, kind: 'plugin', subject: o.actor.toLowerCase(), nickname: name, scope: o.scope, projectId: o.projectId ?? null, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + YEAR).toISOString() }).run();
  db.insert(events).values({ actor: o.actor, type: 'token_created', payload: { id, name, scope: o.scope, projectId: o.projectId ?? null } }).run();
  return { id, token };
}

export function listPluginTokens(db: Db) {
  return db.select().from(sessions).where(and(eq(sessions.kind, 'plugin'), isNotNull(sessions.tokenHash))).all()
    .map((s) => ({ id: s.id, name: s.nickname ?? '', scope: s.scope as TokenScope, projectId: s.projectId, createdBy: s.subject, createdAt: s.createdAt, expiresAt: s.expiresAt }));
}

export function revokePluginToken(db: Db, o: { id: string; actor: string }): void {
  const row = db.select().from(sessions).where(and(eq(sessions.id, o.id), eq(sessions.kind, 'plugin'))).get();
  if (!row || !row.tokenHash) throw new TokenError('not_found');
  db.update(sessions).set({ tokenHash: null, expiresAt: new Date(0).toISOString() }).where(eq(sessions.id, o.id)).run();
  db.insert(events).values({ actor: o.actor, type: 'token_revoked', payload: { id: o.id, name: row.nickname } }).run();
}
