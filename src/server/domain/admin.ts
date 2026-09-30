import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, projects, photos, events } from '../db/schema.js';
import { ProjectMeta, defaultProjectMeta } from './meta.js';
import { newId } from '../ids.js';

export class AdminError extends Error { constructor(public code: 'invalid' | 'exists' | 'not_found' | 'guard') { super(code); this.name = 'AdminError'; } }
export type EventRow = typeof events.$inferSelect;

const proj = async (db: Db, id: string) => { const [r] = await db.select().from(projects).where(eq(projects.id, id)).limit(1); if (!r) throw new AdminError('not_found'); return r; };
const emails = (xs: string[]) => [...new Set(xs.map((e) => e.trim().toLowerCase()).filter(Boolean))];
type ClientFields = { name: string; emails: string[]; phone: string; notes: string };

export async function createClient(db: Db, o: { name: string; emails: string[]; phone?: string; notes?: string; actor: string }): Promise<{ id: string }> {
  const name = o.name.trim(); if (!name) throw new AdminError('invalid');
  const id = newId();
  await db.insert(clients).values({ id, name, emails: emails(o.emails), phone: o.phone?.trim() ?? '', notes: o.notes ?? '' });
  await db.insert(events).values({ actor: o.actor, type: 'client_created', payload: { id } });
  return { id };
}

export async function updateClient(db: Db, o: { clientId: string; patch: Partial<ClientFields>; actor: string }): Promise<void> {
  const [row] = await db.select().from(clients).where(eq(clients.id, o.clientId)).limit(1); if (!row) throw new AdminError('not_found');
  const name = (o.patch.name ?? row.name).trim(); if (!name) throw new AdminError('invalid');
  await db.update(clients).set({ name, emails: emails(o.patch.emails ?? row.emails), phone: o.patch.phone ?? row.phone, notes: o.patch.notes ?? row.notes, stateVersion: row.stateVersion + 1 }).where(eq(clients.id, o.clientId));
  await db.insert(events).values({ actor: o.actor, type: 'client_updated', payload: { id: o.clientId, keys: Object.keys(o.patch) } });
}

export async function createProject(db: Db, o: { clientId: string; title: string; date?: string | null; included?: number; extraPrice?: number; assignedTo?: string | null; actor: string }): Promise<{ id: string }> {
  if (!(await db.select({ id: clients.id }).from(clients).where(eq(clients.id, o.clientId)).limit(1)).length) throw new AdminError('not_found');
  if (!o.title.trim()) throw new AdminError('invalid');
  const p = defaultProjectMeta(o.title.trim()); p.date = o.date ?? null; p.assignedTo = o.assignedTo ?? null;
  p.allowance = { included: o.included ?? 0, extraPrice: o.extraPrice ?? 0 };
  const parsed = ProjectMeta.safeParse(p); if (!parsed.success) throw new AdminError('invalid');
  const id = newId();
  await db.insert(projects).values({ id, clientId: o.clientId, date: p.date, metadataJson: parsed.data as Record<string, unknown> });
  await db.insert(events).values({ projectId: id, actor: o.actor, type: 'project_created', payload: {} });
  return { id };
}

export const HUMAN_PATCH = ['title', 'date', 'assignedTo', 'downloads', 'comments', 'notifyOnPublish', 'music', 'cover', 'expiresAt', 'offers', 'portfolioRelease', 'showOffers', 'package'] as const;

/** Only human fields; machine fields have their own commands. */
export async function updateProjectHuman(db: Db, o: { projectId: string; patch: Partial<ProjectMeta>; actor: string }): Promise<ProjectMeta> {
  const keys = Object.keys(o.patch);
  if (keys.length === 0 || keys.some((k) => !(HUMAN_PATCH as readonly string[]).includes(k))) throw new AdminError('invalid');
  const row = await proj(db, o.projectId);
  const merged = ProjectMeta.safeParse({ ...ProjectMeta.parse(row.metadataJson), ...o.patch }); if (!merged.success) throw new AdminError('invalid');
  await db.update(projects).set({ metadataJson: merged.data as Record<string, unknown>, date: merged.data.date }).where(eq(projects.id, o.projectId));
  await db.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'project_updated', payload: { keys } });
  return merged.data;
}

export async function setExtraPrice(db: Db, o: { projectId: string; extraPrice: number; actor: string }): Promise<void> {
  if (!Number.isInteger(o.extraPrice) || o.extraPrice < 0) throw new AdminError('invalid');
  const row = await proj(db, o.projectId); const meta = ProjectMeta.parse(row.metadataJson); meta.allowance.extraPrice = o.extraPrice;
  await db.update(projects).set({ metadataJson: meta as Record<string, unknown> }).where(eq(projects.id, o.projectId));
  await db.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'price_changed', payload: { extraPrice: o.extraPrice } });
}

export async function markShot(db: Db, o: { projectId: string; actor: string }): Promise<void> {
  const row = await proj(db, o.projectId); if (row.productionState !== 'not_started') throw new AdminError('guard');
  await db.transaction(async (tx) => {
    const n = (await tx.update(projects).set({ productionState: 'shot', stateVersion: row.stateVersion + 1 }).where(and(eq(projects.id, o.projectId), eq(projects.stateVersion, row.stateVersion))).returning({ id: projects.id })).length;
    if (!n) throw new AdminError('guard');
    await tx.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'production_changed', payload: { from: 'not_started', to: 'shot' } });
  });
}

export async function reorderPhotos(db: Db, o: { projectId: string; ids: string[]; actor: string }): Promise<void> {
  const finals = await db.select().from(photos).where(and(eq(photos.projectId, o.projectId), eq(photos.stage, 'final')));
  const set = new Set(finals.map((f) => f.id));
  if (o.ids.length === 0 || o.ids.some((id) => !set.has(id)) || new Set(o.ids).size !== o.ids.length) throw new AdminError('invalid');
  await db.transaction(async (tx) => {
    for (const [i, id] of o.ids.entries()) await tx.update(photos).set({ sortOrder: i }).where(eq(photos.id, id));
    let n = o.ids.length; for (const f of finals.sort((a, b) => a.sortOrder - b.sortOrder)) if (!o.ids.includes(f.id)) await tx.update(photos).set({ sortOrder: n++ }).where(eq(photos.id, f.id));
    await tx.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'reordered', payload: { count: o.ids.length } });
  });
}

export async function setCover(db: Db, o: { projectId: string; photoId: string | null; actor: string }): Promise<void> {
  let cover: string | null = null;
  if (o.photoId) {
    const [ph] = await db.select().from(photos).where(and(eq(photos.id, o.photoId), eq(photos.projectId, o.projectId))).limit(1);
    if (!ph || ph.stage !== 'final') throw new AdminError('invalid'); cover = ph.relPath;
  }
  await updateProjectHuman(db, { projectId: o.projectId, patch: { cover }, actor: o.actor });
}

export async function projectEvents(db: Db, projectId: string, limit = 100): Promise<EventRow[]> {
  return db.select().from(events).where(eq(events.projectId, projectId)).orderBy(desc(events.at), desc(events.id)).limit(limit);
}

export async function projectInsights(db: Db, projectId: string) {
  const rows = await db.select().from(events).where(eq(events.projectId, projectId));
  const day = (at: string) => at.slice(0, 10);
  const byDay = new Map<string, { day: string; views: number; picks: number; comments: number }>();
  const visitors = new Map<string, { actor: string; views: number; lastSeen: string }>();
  for (const e of rows) {
    if (!['viewed', 'picked', 'commented'].includes(e.type)) continue;
    const d = byDay.get(day(e.at)) ?? { day: day(e.at), views: 0, picks: 0, comments: 0 }; byDay.set(d.day, d);
    if (e.type === 'viewed') { d.views++; const v = visitors.get(e.actor) ?? { actor: e.actor, views: 0, lastSeen: e.at }; v.views++; if (e.at > v.lastSeen) v.lastSeen = e.at; visitors.set(e.actor, v); }
    if (e.type === 'picked') d.picks++;
    if (e.type === 'commented') d.comments++;
  }
  return { views: rows.filter((e) => e.type === 'viewed').length, uniqueVisitors: visitors.size, byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)), visitors: [...visitors.values()].sort((a, b) => b.views - a.views) };
}
