import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, projects, photos, events } from '../db/schema.js';
import { rescan, writeProjection } from '../fs/index.js';
import { readJson, writeJsonAtomic } from '../fs/json.js';
import { ClientJson, ProjectJson, MACHINE_FIELDS, defaultClientJson, defaultProjectJson } from '../fs/schemas.js';
import { isReserved } from '../fs/paths.js';

export class AdminError extends Error { constructor(public code: 'invalid' | 'exists' | 'not_found' | 'guard') { super(code); this.name = 'AdminError'; } }
export type EventRow = typeof events.$inferSelect;

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Untitled';
const exists = (p: string) => stat(p).then(() => true, () => false);
async function freeFolder(base: string, name: string): Promise<string> {
  for (let i = 1; i < 1000; i++) { const n = i === 1 ? name : `${name} (${i})`; if (!(await exists(join(base, n)))) return n; }
  throw new AdminError('exists');
}
const proj = (db: Db, id: string) => { const r = db.select().from(projects).where(eq(projects.id, id)).get(); if (!r) throw new AdminError('not_found'); return r; };
const emails = (xs: string[]) => [...new Set(xs.map((e) => e.trim().toLowerCase()).filter(Boolean))];

export async function createClient(db: Db, photosDir: string, o: { name: string; emails: string[]; actor: string }): Promise<{ id: string; folderPath: string }> {
  const base = join(photosDir, 'Clients'); await mkdir(base, { recursive: true });
  const folder = await freeFolder(base, safeName(o.name)); const folderPath = `Clients/${folder}`;
  const c = defaultClientJson(o.name.trim() || folder); c.emails = emails(o.emails);
  await mkdir(join(base, folder)); await writeJsonAtomic(join(base, folder, 'client.json'), c);
  db.insert(events).values({ actor: o.actor, type: 'client_created', payload: { id: c.id, folderPath } }).run();
  await rescan(db, photosDir);
  return { id: c.id!, folderPath };
}

export async function updateClient(db: Db, photosDir: string, o: { clientId: string; patch: Partial<Pick<ClientJson, 'name' | 'emails' | 'phone' | 'notes'>>; actor: string }): Promise<void> {
  const row = db.select().from(clients).where(eq(clients.id, o.clientId)).get(); if (!row) throw new AdminError('not_found');
  const file = join(photosDir, row.folderPath, 'client.json');
  const cur = await readJson(file, ClientJson); if (!cur.ok) throw new AdminError('not_found');
  const next = { ...cur.data, ...o.patch, emails: emails(o.patch.emails ?? cur.data.emails) };
  if (!next.name?.trim()) throw new AdminError('invalid');
  await writeJsonAtomic(file, next);
  db.insert(events).values({ actor: o.actor, type: 'client_updated', payload: { id: o.clientId, keys: Object.keys(o.patch) } }).run();
  await rescan(db, photosDir);
}

export async function createProject(db: Db, photosDir: string, o: { clientId: string; title: string; date?: string | null; included?: number; extraPrice?: number; assignedTo?: string | null; actor: string }): Promise<{ id: string; folderPath: string }> {
  const c = db.select().from(clients).where(eq(clients.id, o.clientId)).get(); if (!c) throw new AdminError('not_found');
  if (!o.title.trim()) throw new AdminError('invalid');
  const base = join(photosDir, c.folderPath); const folder = await freeFolder(base, safeName(o.title)); const folderPath = `${c.folderPath}/${folder}`;
  const p = defaultProjectJson(o.title.trim()); p.date = o.date ?? null; p.assignedTo = o.assignedTo ?? null;
  const inc = o.included ?? 0; p.allowance = { included: inc, extraPrice: o.extraPrice ?? 0, slots: inc };
  for (const d of ['raw', 'finals', 'documents']) await mkdir(join(base, folder, d), { recursive: true });
  await writeJsonAtomic(join(base, folder, 'project.json'), p);
  db.insert(events).values({ projectId: p.id, actor: o.actor, type: 'project_created', payload: { folderPath } }).run();
  await rescan(db, photosDir);
  return { id: p.id!, folderPath };
}

export const HUMAN_PATCH = ['title', 'date', 'assignedTo', 'folders', 'downloads', 'comments', 'notifyOnPublish', 'music', 'cover', 'expiresAt', 'offers', 'portfolioRelease', 'showOffers', 'package', 'sharedFiles'] as const;

/** Only human fields; machine fields have their own commands. */
export async function updateProjectHuman(db: Db, photosDir: string, o: { projectId: string; patch: Partial<ProjectJson>; actor: string }): Promise<ProjectJson> {
  const keys = Object.keys(o.patch);
  if (keys.length === 0 || keys.some((k) => (MACHINE_FIELDS as readonly string[]).includes(k) || !(HUMAN_PATCH as readonly string[]).includes(k))) throw new AdminError('invalid');
  const row = proj(db, o.projectId);
  const merged = ProjectJson.safeParse({ ...ProjectJson.parse(row.metadataJson), ...o.patch }); if (!merged.success) throw new AdminError('invalid');
  db.update(projects).set({ metadataJson: merged.data as Record<string, unknown>, date: merged.data.date }).where(eq(projects.id, o.projectId)).run();
  db.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'project_updated', payload: { keys } }).run();
  await writeProjection(db, photosDir, o.projectId);
  return ProjectJson.parse(proj(db, o.projectId).metadataJson);
}

export async function setExtraPrice(db: Db, photosDir: string, o: { projectId: string; extraPrice: number; actor: string }): Promise<void> {
  if (!Number.isInteger(o.extraPrice) || o.extraPrice < 0) throw new AdminError('invalid');
  const row = proj(db, o.projectId); const meta = ProjectJson.parse(row.metadataJson); meta.allowance.extraPrice = o.extraPrice;
  db.update(projects).set({ metadataJson: meta as Record<string, unknown> }).where(eq(projects.id, o.projectId)).run();
  db.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'price_changed', payload: { extraPrice: o.extraPrice } }).run();
  await writeProjection(db, photosDir, o.projectId);
}

export async function markShot(db: Db, photosDir: string, o: { projectId: string; actor: string }): Promise<void> {
  const row = proj(db, o.projectId); if (row.productionState !== 'not_started') throw new AdminError('guard');
  db.transaction((tx) => {
    tx.update(projects).set({ productionState: 'shot', stateVersion: row.stateVersion + 1 }).where(and(eq(projects.id, o.projectId), eq(projects.stateVersion, row.stateVersion))).run();
    tx.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'production_changed', payload: { from: 'not_started', to: 'shot' } }).run();
  });
  await writeProjection(db, photosDir, o.projectId);
}

export function reorderPhotos(db: Db, o: { projectId: string; ids: string[]; actor: string }): void {
  const finals = db.select().from(photos).where(and(eq(photos.projectId, o.projectId), eq(photos.stage, 'final'))).all();
  const set = new Set(finals.map((f) => f.id));
  if (o.ids.length === 0 || o.ids.some((id) => !set.has(id)) || new Set(o.ids).size !== o.ids.length) throw new AdminError('invalid');
  db.transaction((tx) => {
    o.ids.forEach((id, i) => tx.update(photos).set({ sortOrder: i }).where(eq(photos.id, id)).run());
    let n = o.ids.length; for (const f of finals.sort((a, b) => a.sortOrder - b.sortOrder)) if (!o.ids.includes(f.id)) tx.update(photos).set({ sortOrder: n++ }).where(eq(photos.id, f.id)).run();
    tx.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'reordered', payload: { count: o.ids.length } }).run();
  });
}

export async function setCover(db: Db, photosDir: string, o: { projectId: string; photoId: string | null; actor: string }): Promise<void> {
  let cover: string | null = null;
  if (o.photoId) { const ph = db.select().from(photos).where(and(eq(photos.id, o.photoId), eq(photos.projectId, o.projectId))).get(); if (!ph || ph.stage !== 'final') throw new AdminError('invalid'); cover = ph.relPath; }
  await updateProjectHuman(db, photosDir, { projectId: o.projectId, patch: { cover }, actor: o.actor });
}

/** Attachments only: media folders and metadata are never "shared files". */
export async function setSharedFiles(db: Db, photosDir: string, o: { projectId: string; rel: string; shared: boolean; actor: string }): Promise<string[]> {
  const row = proj(db, o.projectId); const meta = ProjectJson.parse(row.metadataJson);
  const rel = o.rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..') || isReserved(rel) || [meta.folders.culling, meta.folders.finals].some((f) => rel === f || rel.startsWith(f + '/')) || rel === 'project.json') throw new AdminError('invalid');
  if (o.shared && !(await stat(join(photosDir, row.folderPath, rel)).then((s) => s.isFile(), () => false))) throw new AdminError('not_found');
  const next = o.shared ? [...new Set([...meta.sharedFiles, rel])] : meta.sharedFiles.filter((x) => x !== rel);
  await updateProjectHuman(db, photosDir, { projectId: o.projectId, patch: { sharedFiles: next }, actor: o.actor });
  return next;
}

export function projectEvents(db: Db, projectId: string, limit = 100): EventRow[] {
  return db.select().from(events).where(eq(events.projectId, projectId)).orderBy(desc(events.at), desc(events.id)).limit(limit).all();
}

export function projectInsights(db: Db, projectId: string) {
  const rows = db.select().from(events).where(eq(events.projectId, projectId)).all();
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
