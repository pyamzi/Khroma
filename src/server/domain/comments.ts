import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, comments, events } from '../db/schema.js';
import { ProjectMeta } from './meta.js';
import { newId } from '../ids.js';

export class CommentError extends Error { constructor(public code: 'disabled' | 'invalid' | 'unknown_photo') { super(code); this.name = 'CommentError'; } }
export type CommentRow = typeof comments.$inferSelect;
export type CommentInput = { text: string; x?: number; y?: number; w?: number; h?: number; t?: number };

export async function commentsAllowed(db: Db, projectId: string, stage: 'culling' | 'final'): Promise<boolean> {
  const [row] = await db.select({ m: projects.metadataJson }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!row) return false;
  const c = ProjectMeta.parse(row.m).comments;
  return stage === 'culling' ? c.culling : c.finals;
}

const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Region (photos) or timestamp (videos), never both; text 1–2000 chars; clients need the per-stage toggle. */
export async function addComment(db: Db, o: { photoId: string; author: string; isAdmin: boolean; input: CommentInput }): Promise<CommentRow> {
  const [ph] = await db.select().from(photos).where(eq(photos.id, o.photoId)).limit(1);
  if (!ph || ph.projectId === null) throw new CommentError('unknown_photo'); // Library photos carry no comment threads
  if (!o.isAdmin && !(await commentsAllowed(db, ph.projectId, ph.stage))) throw new CommentError('disabled');
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
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(comments).values({ id, photoId: ph.id, author: o.author.toLowerCase(), stage: ph.stage, text, x: hasRegion ? x! : null, y: hasRegion ? y! : null, w: hasRegion ? w! : null, h: hasRegion ? h! : null, t: hasT ? t! : null }).returning();
    await tx.insert(events).values({ projectId: ph.projectId, actor: o.author.toLowerCase(), type: 'commented', payload: { photoId: ph.id, commentId: id } });
    return row!;
  });
}

export async function listComments(db: Db, photoId: string): Promise<CommentRow[]> {
  return db.select().from(comments).where(eq(comments.photoId, photoId)).orderBy(comments.createdAt);
}

export async function resolveComment(db: Db, o: { commentId: string; actor: string; resolved: boolean }): Promise<CommentRow> {
  const [c] = await db.select().from(comments).where(eq(comments.id, o.commentId)).limit(1);
  if (!c) throw new CommentError('unknown_photo');
  const [ph] = await db.select({ projectId: photos.projectId }).from(photos).where(eq(photos.id, c.photoId)).limit(1);
  return db.transaction(async (tx) => {
    const [row] = await tx.update(comments).set({ resolvedAt: o.resolved ? new Date().toISOString() : null }).where(eq(comments.id, o.commentId)).returning();
    await tx.insert(events).values({ projectId: ph!.projectId, actor: o.actor, type: 'comment_resolved', payload: { commentId: o.commentId, resolved: o.resolved } });
    return row!;
  });
}

export async function commentCounts(db: Db, projectId: string): Promise<Record<string, { open: number; total: number }>> {
  const rows = await db.select({ photoId: comments.photoId, open: sql<number>`sum(case when ${comments.resolvedAt} is null then 1 else 0 end)`, total: sql<number>`count(*)` })
    .from(comments).innerJoin(photos, eq(photos.id, comments.photoId)).where(eq(photos.projectId, projectId)).groupBy(comments.photoId);
  return Object.fromEntries(rows.map((r) => [r.photoId, { open: Number(r.open), total: Number(r.total) }]));
}
