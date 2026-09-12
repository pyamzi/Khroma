import { mkdir as fsMkdir, readdir, rename, stat, writeFile, unlink, rm, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join, posix } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, clients, events } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { resolveInside, isReserved, PathError } from '../fs/paths.js';
import { rescan, approveTransfer } from '../fs/index.js';
import { sniff } from '../fs/media.js';
import { ProjectJson } from '../fs/schemas.js';
import type { Handlers } from '../jobs/queue.js';

export class FilesError extends Error { constructor(public code: 'reserved' | 'exists' | 'not_found' | 'too_large' | 'unsupported' | 'needs_confirm' | 'invalid') { super(code); this.name = 'FilesError'; } }
export type Entry = { name: string; rel: string; kind: 'dir' | 'file' | 'client' | 'project'; size: number | null; mtime: string; id?: string; badge?: { state: string; available: boolean; transferPending: boolean }; media?: 'photo' | 'video' | 'document' | 'audio' | null };

const META = new Set(['client.json', 'project.json']);
const EXEC = new Set(['.sh', '.exe', '.bat', '.cmd', '.com', '.msi', '.app', '.scr', '.ps1', '.php', '.html', '.htm', '.js', '.mjs', '.dll', '.so', '.dylib']);
const MEDIA_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.mp4', '.mov', '.m4v', '.nef', '.cr2', '.cr3', '.arw', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw']);
export const norm = (rel: string) => { const r = posix.normalize(rel.replace(/\\/g, '/')).replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, ''); return r === '.' ? '' : r; };
function guard(rel: string, allowMeta = false) {
  if (rel.split('/').some((s) => s === '..')) throw new PathError('traversal');
  if (isReserved(rel) || (!allowMeta && META.has(basename(rel)))) throw new FilesError('reserved');
}
const exists = (p: string) => stat(p).then(() => true, () => false);
function limits(db: Db) { const l = getSetting<{ attachmentBytes?: number; mediaBytes?: number }>(db, 'limits') ?? {}; return { attachment: l.attachmentBytes ?? 2 * 1024 ** 3, media: l.mediaBytes ?? 20 * 1024 ** 3 }; }

export async function listDir(db: Db, photosDir: string, relIn: string): Promise<{ rel: string; entries: Entry[] }> {
  const rel = norm(relIn); if (rel) guard(rel, true);
  const abs = await resolveInside(photosDir, rel || '.');
  let dirents; try { dirents = await readdir(abs, { withFileTypes: true }); } catch { throw new FilesError('not_found'); }
  const byPath = new Map<string, { kind: 'client' | 'project'; id: string; badge?: Entry['badge'] }>();
  for (const c of db.select().from(clients).all()) byPath.set(c.folderPath, { kind: 'client', id: c.id });
  for (const p of db.select().from(projects).all()) byPath.set(p.folderPath, { kind: 'project', id: p.id, badge: { state: p.productionState, available: p.available, transferPending: p.transferPending } });
  const entries: Entry[] = [];
  for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.name.startsWith('.') || META.has(d.name) || d.name.endsWith('.part')) continue;
    const r = rel ? `${rel}/${d.name}` : d.name; const s = await stat(join(abs, d.name)).catch(() => null); if (!s) continue;
    if (d.isDirectory()) { const k = byPath.get(r); entries.push({ name: d.name, rel: r, kind: k?.kind ?? 'dir', size: null, mtime: s.mtime.toISOString(), ...(k ? { id: k.id, badge: k.badge } : {}) }); }
    else if (d.isFile()) { const sn = await sniff(join(abs, d.name)).catch(() => null); entries.push({ name: d.name, rel: r, kind: 'file', size: s.size, mtime: s.mtime.toISOString(), media: sn?.kind ?? null }); }
  }
  return { rel, entries };
}

export async function mkdir(db: Db, photosDir: string, relIn: string, actor: string): Promise<Entry> {
  const rel = norm(relIn); if (!rel) throw new FilesError('invalid'); guard(rel);
  const abs = await resolveInside(photosDir, rel);
  if (await exists(abs)) throw new FilesError('exists');
  await fsMkdir(abs, { recursive: true });
  db.insert(events).values({ actor, type: 'folder_created', payload: { rel } }).run();
  if (rel.startsWith('Clients/')) await rescan(db, photosDir);
  const s = await stat(abs); return { name: basename(rel), rel, kind: 'dir', size: null, mtime: s.mtime.toISOString() };
}

const projectAt = (db: Db, rel: string) => db.select().from(projects).where(eq(projects.folderPath, rel)).get() ?? null;
const clientOf = (rel: string) => { const m = rel.match(/^Clients\/([^/]+)\//); return m ? `Clients/${m[1]}` : null; };

/** Rename or move. Identity follows the id, never the path; a project moved between clients needs an explicit confirm. */
export async function move(db: Db, photosDir: string, o: { from: string; to: string; actor: string; confirm?: boolean }): Promise<{ rel: string; transfer?: 'approved' }> {
  const from = norm(o.from); const to = norm(o.to); if (!from || !to || from === to) throw new FilesError('invalid');
  guard(from); guard(to);
  if (to.startsWith(from + '/')) throw new FilesError('invalid');
  const fromAbs = await resolveInside(photosDir, from); const toAbs = await resolveInside(photosDir, to);
  if (!(await exists(fromAbs))) throw new FilesError('not_found');
  if (await exists(toAbs)) throw new FilesError('exists');
  const proj = projectAt(db, from);
  const crossClient = !!proj && clientOf(from) !== clientOf(to);
  if (crossClient && !o.confirm) throw new FilesError('needs_confirm');
  await fsMkdir(dirname(toAbs), { recursive: true });
  await rename(fromAbs, toAbs);
  db.insert(events).values({ projectId: proj?.id ?? null, actor: o.actor, type: 'moved', payload: { from, to } }).run();
  const owner = proj ? null : db.select().from(projects).all().find((p) => from.startsWith(p.folderPath + '/'));
  if (owner) {
    const meta = ProjectJson.parse(owner.metadataJson);
    const inMedia = [meta.folders.culling, meta.folders.finals].some((f) => from.startsWith(`${owner.folderPath}/${f}/`));
    if (inMedia) db.insert(events).values({ projectId: owner.id, actor: o.actor, type: 'media_renamed_externally', payload: { from: from.slice(owner.folderPath.length + 1), to: to.startsWith(owner.folderPath + '/') ? to.slice(owner.folderPath.length + 1) : null } }).run();
  }
  if (from.startsWith('Clients/') || to.startsWith('Clients/')) await rescan(db, photosDir);
  if (crossClient && proj) { await approveTransfer(db, photosDir, proj.id, o.actor); await rescan(db, photosDir); return { rel: to, transfer: 'approved' }; }
  return { rel: to };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
export async function trash(db: Db, photosDir: string, o: { rel: string; actor: string }): Promise<{ trashRel: string }> {
  const rel = norm(o.rel); if (!rel) throw new FilesError('invalid'); guard(rel);
  const abs = await resolveInside(photosDir, rel); if (!(await exists(abs))) throw new FilesError('not_found');
  const trashRel = `.trash/${stamp()}__${rel.replace(/\//g, '␣')}`;
  const trashAbs = join(photosDir, trashRel); await fsMkdir(dirname(trashAbs), { recursive: true });
  await rename(abs, trashAbs);
  await writeFile(`${trashAbs}.json`, JSON.stringify({ original: rel, trashedAt: new Date().toISOString(), actor: o.actor }));
  const proj = projectAt(db, rel);
  db.insert(events).values({ projectId: proj?.id ?? null, actor: o.actor, type: 'trashed', payload: { rel, trashRel } }).run();
  if (rel.startsWith('Clients/')) await rescan(db, photosDir);
  return { trashRel };
}

export async function listTrash(photosDir: string): Promise<{ trashRel: string; original: string; trashedAt: string; size: number | null }[]> {
  const dir = join(photosDir, '.trash'); let names: string[]; try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
    const meta = JSON.parse(await readFile(join(dir, n), 'utf8')) as { original: string; trashedAt: string };
    const item = n.slice(0, -5); const s = await stat(join(dir, item)).catch(() => null); if (!s) continue;
    out.push({ trashRel: `.trash/${item}`, original: meta.original, trashedAt: meta.trashedAt, size: s.isFile() ? s.size : null });
  }
  return out;
}

export async function restore(db: Db, photosDir: string, o: { trashRel: string; actor: string }): Promise<{ rel: string }> {
  const trashRel = norm(o.trashRel); if (!trashRel.startsWith('.trash/') || trashRel.split('/').length !== 2) throw new FilesError('invalid');
  const trashAbs = join(photosDir, trashRel); if (!(await exists(trashAbs))) throw new FilesError('not_found');
  const meta = JSON.parse(await readFile(`${trashAbs}.json`, 'utf8')) as { original: string };
  const rel = norm(meta.original); guard(rel);
  const abs = await resolveInside(photosDir, rel); if (await exists(abs)) throw new FilesError('exists');
  await fsMkdir(dirname(abs), { recursive: true }); await rename(trashAbs, abs); await unlink(`${trashAbs}.json`);
  db.insert(events).values({ actor: o.actor, type: 'restored', payload: { rel, trashRel } }).run();
  if (rel.startsWith('Clients/')) await rescan(db, photosDir);
  return { rel };
}

export async function purgeTrash(photosDir: string, olderThanMs = 30 * 864e5): Promise<number> {
  let n = 0; const cutoff = Date.now() - olderThanMs;
  for (const t of await listTrash(photosDir)) if (Date.parse(t.trashedAt) <= cutoff) { await rm(join(photosDir, t.trashRel), { recursive: true, force: true }); await unlink(join(photosDir, `${t.trashRel}.json`)).catch(() => {}); n++; }
  return n;
}
export const filesHandlers = (photosDir: string): Handlers => ({ trash_purge: async () => { await purgeTrash(photosDir); } });

/** ponytail: whole-file writes; chunked uploads are deferred in the spec. */
export async function writeUpload(db: Db, photosDir: string, o: { dirRel: string; name: string; bytes: Buffer | NodeJS.ReadableStream; size: number; actor: string }): Promise<Entry> {
  const dirRel = norm(o.dirRel); if (dirRel) guard(dirRel, true);
  const name = basename(o.name.replace(/\\/g, '/')).replace(/^\.+/, '').trim();
  if (!name) throw new FilesError('invalid'); if (META.has(name)) throw new FilesError('reserved');
  const ext = posix.extname(name).toLowerCase(); if (EXEC.has(ext)) throw new FilesError('unsupported');
  const rel = dirRel ? `${dirRel}/${name}` : name; guard(rel);
  const abs = await resolveInside(photosDir, rel); if (await exists(abs)) throw new FilesError('exists');
  if (!(await exists(dirname(abs)))) throw new FilesError('not_found');
  const lim = limits(db); if (o.size > (MEDIA_EXT.has(ext) ? lim.media : lim.attachment)) throw new FilesError('too_large');
  const part = `${abs}.part`;
  try {
    if (Buffer.isBuffer(o.bytes)) await writeFile(part, o.bytes); else await pipeline(o.bytes, createWriteStream(part));
    await rename(part, abs);
  } catch (e) { await unlink(part).catch(() => {}); throw e; }
  const s = await stat(abs); const sn = await sniff(abs).catch(() => null);
  db.insert(events).values({ actor: o.actor, type: 'uploaded', payload: { rel, size: s.size } }).run();
  return { name, rel, kind: 'file', size: s.size, mtime: s.mtime.toISOString(), media: sn?.kind ?? null };
}
