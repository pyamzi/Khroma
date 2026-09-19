import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, comments, events } from '../db/schema.js';
import { ProjectJson } from '../fs/schemas.js';
import { newId } from '../fs/ids.js';

export class CommentError extends Error { constructor(public code: 'disabled' | 'invalid' | 'unknown_photo') { super(code); this.name = 'CommentError'; } }
export type CommentRow = typeof comments.$inferSelect;
export type CommentInput = { text: string; x?: number; y?: number; w?: number; h?: number; t?: number };

export function commentsAllowed(db: Db, projectId: string, stage: 'culling' | 'final'): boolean {
  const row = db.select({ m: projects.metadataJson }).from(projects).where(eq(projects.id, projectId)).get();
  if (!row) return false;
  const c = ProjectJson.parse(row.m).comments;
  return stage === 'culling' ? c.culling : c.finals;
}

const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Region (photos) or timestamp (videos), never both; text 1–2000 chars; clients need the per-stage toggle. */
export function addComment(db: Db, o: { photoId: string; author: string; isAdmin: boolean; input: CommentInput }): CommentRow {
  const ph = db.select().from(photos).where(eq(photos.id, o.photoId)).get();
  if (!ph) throw new CommentError('unknown_photo');
  if (!o.isAdmin && !commentsAllowed(db, ph.projectId, ph.stage)) throw new CommentError('disabled');
  const text = (o.input.text ?? '').trim();
  if (text.length < 1 || text.length > 2000) throw new CommentError('invalid');
  const { x, y, w, h, t } = o.input;
  const hasRegion = [x, y, w, h].some((n) => n !== undefined); const hasT = t !== undefined;
  if (hasRegion && hasT) throw new CommentError('invalid');
  if (hasRegion) {
    if (ph.kind !== 'photo') throw new CommentError('invalid');
    if (!unit(x) || !unit(y) || !unit(w) || !unit(h) || w <= 0 || h <= 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) throw new CommentError('invalid');
  }
  if (hasT && (ph.kind !== 'video' || typeof t !== 'number' || !Number.isFinite(t) || t < 0)) throw new CommentError('invalid');
  const id = newId();
  db.transaction((tx) => {
    tx.insert(comments).values({ id, photoId: ph.id, author: o.author.toLowerCase(), stage: ph.stage, text, x: hasRegion ? x! : null, y: hasRegion ? y! : null, w: hasRegion ? w! : null, h: hasRegion ? h! : null, t: hasT ? t! : null }).run();
    tx.insert(events).values({ projectId: ph.projectId, actor: o.author.toLowerCase(), type: 'commented', payload: { photoId: ph.id, commentId: id } }).run();
  });
  return db.select().from(comments).where(eq(comments.id, id)).get()!;
}

export function listComments(db: Db, photoId: string): CommentRow[] {
  return db.select().from(comments).where(eq(comments.photoId, photoId)).orderBy(comments.createdAt).all();
}

export function resolveComment(db: Db, o: { commentId: string; actor: string; resolved: boolean }): CommentRow {
  const c = db.select().from(comments).where(eq(comments.id, o.commentId)).get();
  if (!c) throw new CommentError('unknown_photo');
  const ph = db.select({ projectId: photos.projectId }).from(photos).where(eq(photos.id, c.photoId)).get()!;
  db.transaction((tx) => {
    tx.update(comments).set({ resolvedAt: o.resolved ? new Date().toISOString() : null }).where(eq(comments.id, o.commentId)).run();
    tx.insert(events).values({ projectId: ph.projectId, actor: o.actor, type: 'comment_resolved', payload: { commentId: o.commentId, resolved: o.resolved } }).run();
  });
  return db.select().from(comments).where(eq(comments.id, o.commentId)).get()!;
}

export function commentCounts(db: Db, projectId: string): Record<string, { open: number; total: number }> {
  const rows = db.select({ photoId: comments.photoId, open: sql<number>`sum(case when ${comments.resolvedAt} is null then 1 else 0 end)`, total: sql<number>`count(*)` })
    .from(comments).innerJoin(photos, eq(photos.id, comments.photoId)).where(eq(photos.projectId, projectId)).groupBy(comments.photoId).all();
  return Object.fromEntries(rows.map((r) => [r.photoId, { open: Number(r.open), total: Number(r.total) }]));
}
