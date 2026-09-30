import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, projects, photos, comments, events, jobs } from '../db/schema.js';
import { ProjectMeta } from './meta.js';

export type Item = { projectId: string; title: string; client: string; reason: string; count?: number; since: string };
const IDLE_MS = 3 * 864e5;

// ponytail: loads the Studio's projects and events in full; paginate or aggregate in SQL once a Studio has thousands of projects.
/** Four blocks, nothing else. Money arrives with invoicing. */
export async function dashboard(db: Db, now = Date.now()) {
  const cl = new Map((await db.select().from(clients)).map((c) => [c.id, c.name]));
  const ps = (await db.select().from(projects)).filter((p) => p.archivedAt === null && p.bookingState !== 'cancelled');
  const title = (p: (typeof ps)[number]) => ProjectMeta.parse(p.metadataJson).title;
  const ev = await db.select().from(events);
  const last = (pid: string, types: string[]) => ev.filter((e) => e.projectId === pid && types.includes(e.type)).map((e) => e.at).sort().at(-1) ?? null;
  const waitingOnYou: Item[] = []; const waitingOnClient: Item[] = [];
  for (const p of ps) {
    const base = { projectId: p.id, title: title(p), client: cl.get(p.clientId) ?? '' };
    const rows = await db.select().from(photos).where(eq(photos.projectId, p.id));
    if (p.productionState === 'editing') {
      const fin = ev.filter((e) => e.projectId === p.id && e.type === 'finished_culling').sort((a, b) => a.at.localeCompare(b.at)).at(-1);
      if (fin) waitingOnYou.push({ ...base, reason: 'culling_finished', count: ((fin.payload as { photoIds?: string[] }).photoIds ?? []).length, since: fin.at });
    }
    const open = await db.select({ id: comments.id, at: comments.createdAt }).from(comments).innerJoin(photos, eq(photos.id, comments.photoId)).where(and(eq(photos.projectId, p.id), isNull(comments.resolvedAt)));
    if (open.length) waitingOnYou.push({ ...base, reason: 'unresolved_comments', count: open.length, since: open.map((c) => c.at).sort()[0]! });
    const drafts = rows.filter((r) => r.draftRelPath);
    if (drafts.length) waitingOnYou.push({ ...base, reason: 'drafts', count: drafts.length, since: last(p.id, ['final_uploaded', 'production_changed']) ?? new Date(now).toISOString() });
    const failed = ev.filter((e) => e.projectId === p.id && e.type === 'preview_failed');
    if (failed.length) waitingOnYou.push({ ...base, reason: 'preview_failed', count: failed.length, since: failed.map((e) => e.at).sort()[0]! });
    if (p.productionState === 'culling') {
      const seen = last(p.id, ['picked', 'unpicked', 'viewed', 'commented']) ?? last(p.id, ['production_changed']);
      if (seen && now - Date.parse(seen) > IDLE_MS) waitingOnClient.push({ ...base, reason: 'culling_idle', since: seen });
    }
  }
  const review = (await db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.state, ['needs_review', 'failed']))).length;
  if (review) waitingOnYou.push({ projectId: '', title: 'Jobs', client: '', reason: 'review_jobs', count: review, since: new Date(now).toISOString() });
  const today = new Date(now).toISOString().slice(0, 10);
  const upcoming = ps.filter((p) => p.date && p.date >= today).sort((a, b) => a.date!.localeCompare(b.date!)).slice(0, 10).map((p) => ({ projectId: p.id, title: title(p), client: cl.get(p.clientId) ?? '', date: p.date! }));
  return { waitingOnYou, waitingOnClient, money: [] as never[], upcoming };
}
