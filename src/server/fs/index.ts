import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, projects, events } from '../db/schema.js';
import { readJson, writeJsonAtomic } from './json.js';
import { ClientJson, ProjectJson, MACHINE_FIELDS, splitFields } from './schemas.js';
import { newId } from './ids.js';

export type Issue = {
  kind: 'malformed' | 'wrong_depth' | 'duplicate_id' | 'missing' | 'transfer_pending' | 'machine_field_edited';
  path: string; id?: string; detail?: string;
};
export type RescanReport = { clients: number; projects: number; issues: Issue[] };

let issues: Issue[] = [];
export function currentIssues(): Issue[] { return issues; }
export function projectDir(photosDir: string, row: { folderPath: string }): string { return join(photosDir, row.folderPath); }

async function subdirs(abs: string): Promise<string[]> {
  try { return (await readdir(abs, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort(); }
  catch { return []; }
}
const exists = (p: string) => stat(p).then(() => true, () => false);

type Found<T> = { rel: string; abs: string; data: T };
type FoundProject = Found<ProjectJson> & { clientId: string };
/** A folder whose JSON is unreadable: keep whatever the db already knows about it. */
type Held = { rel: string; kind: 'client' | 'project' };

export async function rescan(db: Db, photosDir: string): Promise<RescanReport> {
  const found: Issue[] = [];
  const clientsRoot = join(photosDir, 'Clients');
  const seenClients: Found<ClientJson>[] = [];
  const seenProjects: FoundProject[] = [];
  const held: Held[] = [];

  for (const cname of await subdirs(clientsRoot)) {
    const cabs = join(clientsRoot, cname); const crel = `Clients/${cname}`;
    if (await exists(join(cabs, 'project.json'))) { found.push({ kind: 'wrong_depth', path: crel, detail: 'project.json directly under Clients/' }); continue; }
    const cr = await readJson(join(cabs, 'client.json'), ClientJson);
    if (!cr.ok) { if (!cr.missing) { found.push({ kind: 'malformed', path: crel, detail: cr.error }); held.push({ rel: crel, kind: 'client' }); } continue; }
    if (!cr.data.id) { cr.data.id = newId(); await writeJsonAtomic(join(cabs, 'client.json'), cr.data); }
    seenClients.push({ rel: crel, abs: cabs, data: cr.data });
    for (const pname of await subdirs(cabs)) {
      const pabs = join(cabs, pname); const prel = `${crel}/${pname}`;
      if (await exists(join(pabs, 'client.json'))) { found.push({ kind: 'wrong_depth', path: prel, detail: 'client.json nested inside a client' }); continue; }
      const pr = await readJson(join(pabs, 'project.json'), ProjectJson);
      if (!pr.ok) { if (!pr.missing) { found.push({ kind: 'malformed', path: prel, detail: pr.error }); held.push({ rel: prel, kind: 'project' }); } continue; }
      if (!pr.data.id) { pr.data.id = newId(); await writeJsonAtomic(join(pabs, 'project.json'), pr.data); }
      seenProjects.push({ rel: prel, abs: pabs, data: pr.data, clientId: cr.data.id });
    }
  }

  // duplicate ids → quarantine every location that carries them
  const dupe = <T extends { rel: string; data: { id?: string } }>(list: T[]): Set<string> => {
    const byId = new Map<string, T[]>();
    for (const f of list) byId.set(f.data.id!, [...(byId.get(f.data.id!) ?? []), f]);
    const bad = new Set<string>();
    for (const [id, fs] of byId) if (fs.length > 1) { bad.add(id); for (const f of fs) found.push({ kind: 'duplicate_id', path: f.rel, id }); }
    return bad;
  };
  const badClients = dupe(seenClients); const badProjects = dupe(seenProjects);
  const heldPaths = new Set(held.map((h) => h.rel));

  const restores: Promise<void>[] = [];
  db.transaction((tx) => {
    const keptClientIds = new Set<string>();
    for (const c of seenClients) {
      if (badClients.has(c.data.id!)) { tx.update(clients).set({ available: false }).where(eq(clients.id, c.data.id!)).run(); continue; }
      keptClientIds.add(c.data.id!);
      tx.insert(clients).values({ id: c.data.id!, folderPath: c.rel, name: c.data.name, emails: c.data.emails, stripeCustomerId: c.data.stripeCustomerId, listmonkSubscriberId: c.data.listmonkSubscriberId, referralCode: c.data.referralCode, available: true })
        .onConflictDoUpdate({ target: clients.id, set: { folderPath: c.rel, name: c.data.name, emails: c.data.emails, available: true } }).run();
    }
    for (const row of tx.select().from(clients).all()) {
      if (keptClientIds.has(row.id) || heldPaths.has(row.folderPath)) continue;
      if (row.available) { tx.update(clients).set({ available: false }).where(eq(clients.id, row.id)).run(); found.push({ kind: 'missing', path: row.folderPath, id: row.id }); }
    }

    const keptProjectIds = new Set<string>();
    for (const p of seenProjects) {
      const id = p.data.id!;
      if (badProjects.has(id) || badClients.has(p.clientId)) { tx.update(projects).set({ available: false }).where(eq(projects.id, id)).run(); continue; }
      keptProjectIds.add(id);
      const existing = tx.select().from(projects).where(eq(projects.id, id)).get();
      if (!existing) {
        // first sight: the file's machine fields are accepted only for identity and state; allowance/integrations become the projection baseline
        tx.insert(projects).values({ id, clientId: p.clientId, folderPath: p.rel, date: p.data.date, bookingState: p.data.state.booking, productionState: p.data.state.production, archivedAt: p.data.state.archivedAt, metadataJson: p.data as Record<string, unknown> }).run();
        continue;
      }
      if (existing.transferPending) {
        const pendingTo = (existing.metadataJson as Record<string, unknown>)['pendingClientId'];
        if (p.clientId === existing.clientId) { // moved back home: cancel the pending transfer
          const meta = { ...(existing.metadataJson as Record<string, unknown>) }; delete meta['pendingClientId'];
          tx.update(projects).set({ folderPath: p.rel, transferPending: false, available: true, metadataJson: meta }).where(eq(projects.id, id)).run();
        } else {
          if (pendingTo !== p.clientId) tx.update(projects).set({ folderPath: p.rel, metadataJson: { ...(existing.metadataJson as Record<string, unknown>), pendingClientId: p.clientId } }).where(eq(projects.id, id)).run();
          found.push({ kind: 'transfer_pending', path: p.rel, id });
        }
        continue;
      }
      if (existing.clientId !== p.clientId) {
        tx.update(projects).set({ folderPath: p.rel, available: false, transferPending: true, metadataJson: { ...(existing.metadataJson as Record<string, unknown>), pendingClientId: p.clientId } }).where(eq(projects.id, id)).run();
        found.push({ kind: 'transfer_pending', path: p.rel, id }); continue;
      }
      // machine fields are projections of the db; restore them if the file drifted
      const stored = ProjectJson.parse(existing.metadataJson);
      const projection: ProjectJson = { ...stored, id, stateVersion: existing.stateVersion, state: { booking: existing.bookingState, production: existing.productionState, archivedAt: existing.archivedAt } };
      const drift = MACHINE_FIELDS.filter((k) => JSON.stringify(p.data[k]) !== JSON.stringify(projection[k]));
      const merged: ProjectJson = { ...projection, ...splitFields(p.data).human };
      if (drift.length) { found.push({ kind: 'machine_field_edited', path: p.rel, id, detail: drift.join(',') }); restores.push(writeJsonAtomic(join(p.abs, 'project.json'), merged)); }
      tx.update(projects).set({ folderPath: p.rel, available: true, date: merged.date, metadataJson: merged as Record<string, unknown> }).where(eq(projects.id, id)).run();
    }
    for (const row of tx.select().from(projects).all()) {
      if (keptProjectIds.has(row.id) || heldPaths.has(row.folderPath) || row.transferPending) continue;
      if (row.available) { tx.update(projects).set({ available: false }).where(eq(projects.id, row.id)).run(); found.push({ kind: 'missing', path: row.folderPath, id: row.id }); }
    }
  });
  await Promise.all(restores);

  issues = found;
  return { clients: seenClients.length - badClients.size, projects: seenProjects.length - badProjects.size, issues: found };
}

/** Write the project's JSON from the database (human fields kept from the stored copy). */
export async function writeProjection(db: Db, photosDir: string, projectId: string): Promise<void> {
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!row) throw new Error(`unknown project ${projectId}`);
  const stored = ProjectJson.parse(row.metadataJson);
  const projection: ProjectJson = { ...stored, id: row.id, stateVersion: row.stateVersion, state: { booking: row.bookingState, production: row.productionState, archivedAt: row.archivedAt } };
  db.update(projects).set({ metadataJson: projection as Record<string, unknown> }).where(eq(projects.id, projectId)).run();
  await writeJsonAtomic(join(photosDir, row.folderPath, 'project.json'), projection);
}

export async function approveTransfer(db: Db, photosDir: string, projectId: string, actor: string): Promise<void> {
  db.transaction((tx) => {
    const row = tx.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row?.transferPending) throw new Error('no transfer pending');
    const meta = { ...(row.metadataJson as Record<string, unknown>) }; const to = meta['pendingClientId'] as string; delete meta['pendingClientId'];
    tx.update(projects).set({ clientId: to, transferPending: false, available: true, stateVersion: sql`${projects.stateVersion} + 1`, metadataJson: meta }).where(eq(projects.id, projectId)).run();
    tx.insert(events).values({ projectId, actor, type: 'transferred', payload: { from: row.clientId, to } }).run();
  });
  await writeProjection(db, photosDir, projectId);
}
