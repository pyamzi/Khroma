# OpenGallery Milestone 3: Admin Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The studio can run the product from a browser: a Drive-style Files browser over `/photos` under the write policy, a project detail with photos, activity, insights and editable details, a dashboard of what needs attention, settings (studio, email transport with a delivery test, team, jobs, issues), and one-click resolution of identity conflicts (transfer approval, duplicate adoption, renamed-media remap).

**Architecture:** Three new domain modules (`files`, `admin`, `dashboard`) over M1/M2. `files` is the only code that writes to non-reserved paths and enforces the write policy; `admin` holds the project/client/settings/team commands; `dashboard` derives blocks from events, photos, jobs, and issues. Routes stay thin. The web app gains an admin shell (sidebar on desktop, tab bar on phone) with Dashboard, Files (List/Board), Clients, Settings, and an admin project detail that reuses the M2 viewer with resolve controls. A Playwright admin flow drives it.

**Tech Stack:** As M2. Multipart uploads via Hono's `parseBody` for files under the configured limits; streamed downloads.

**Spec:** `docs/superpowers/specs/2026-09-10-opengallery-design.md` Revision 2, sections 3 (identity, write policy, trash), 7 (admin), 14 (team), 17, 18 (gates *Identity* trash/restore and duplicate adoption, *Write policy* admin surface, *Minimum install* delivery test), 21 milestone 3.

## Global Constraints

- All M1 and M2 global constraints apply.
- **Write policy (spec §3):** every path resolves through `resolveInside(photosDir, rel)`; reserved directories (`.draft`, `.cache`, `.trash`) and `client.json`/`project.json` cannot be written through general upload or rename; originals are never executable or served as HTML; unrecognised types download as attachments; default limits attachments 2 GB, media 20 GB (settings `limits.attachmentBytes`, `limits.mediaBytes`).
- **Identity (spec §3):** a client or project folder moved by the Files browser keeps its id; a cross-client project move requires `confirm: true` and goes through `approveTransfer`; trash keeps rows and ids for 30 days (`available = false`, `trashedAt` in metadata), restore brings them back; duplicate adoption assigns new ids and no transactional state; a renamed media file is remapped only by explicit admin command, never by heuristics.
- **Machine fields stay read-only** in the details form; explicit commands change them (`grant`, `allowance`, `price`, `shot`).
- **Team:** `owner` may manage team, integrations, billing; `member` may not. The last owner cannot be removed or demoted. Invites send an admin magic link.
- **Email delivery test** sends `test_delivery` to the requesting admin as a job and reports the job's state; a failed transport is visible, never silent.
- **Every event records the actor.**
- Commit after every task; conventional prefixes; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Gate commits on typecheck **and** tests.

## File structure

```
src/server/
  domain/files.ts            listDir, mkdir, move, trash, restore, listTrash, writeUpload, purgeTrash (+ job), classify()
  domain/identity.ts         adoptDuplicate, remapPhoto
  domain/admin.ts            createClient, updateClient, createProject, updateProjectHuman, setExtraPrice, markShot, reorderPhotos, setCover, setSharedFiles, projectEvents, projectInsights
  domain/settings.ts         StudioSettings schema, getStudio/setStudio, setEmailConfig, sendDeliveryTest, inviteUser, updateUser, removeUser
  domain/dashboard.ts        dashboard(db)
  http/routes/files.ts       /api/files/* (list, mkdir, upload, move, trash, restore, download, trash list)
  http/routes/admin.ts       /api/clients*, /api/projects (create), /api/projects/:id (patch, price, shot, order, cover, shared, events, insights, files), /api/issues/adopt, /api/projects/:id/photos/remap
  http/routes/settings.ts    /api/settings*, /api/users*, /api/jobs*
  http/routes/dashboard.ts   /api/dashboard
  jobs handlers              trash_purge (daily)
src/web/
  admin/Shell.tsx            sidebar / tab bar, routes
  admin/Dashboard.tsx, Files.tsx, Board.tsx, Clients.tsx, Project.tsx, Settings.tsx
  router.ts                  + /admin routes
tests/domain/files.test.ts, identity.test.ts, admin.test.ts, settings.test.ts, dashboard.test.ts
tests/http/admin.test.ts
tests/e2e/admin.spec.ts
docs/gates/m3-admin.md
```

---

### Task 1: Files domain under the write policy

**Files:**
- Create: `src/server/domain/files.ts`, `tests/domain/files.test.ts`
- Modify: `src/server/db/settings.ts` (no change needed), `src/server/fs/paths.ts` (export `RESERVED_NAMES`)

**Interfaces:**
```ts
export class FilesError extends Error { code: 'reserved' | 'exists' | 'not_found' | 'too_large' | 'unsupported' | 'needs_confirm' | 'invalid' }
export type Entry = { name: string; rel: string; kind: 'dir' | 'file' | 'client' | 'project'; size: number | null; mtime: string; id?: string; badge?: { state: string; available: boolean; transferPending: boolean } ; media?: 'photo' | 'video' | 'document' | 'audio' | null };
export async function listDir(db, photosDir, rel: string): Promise<{ rel: string; entries: Entry[] }>
export async function mkdir(db, photosDir, rel: string, actor: string): Promise<Entry>
export async function move(db, photosDir, o: { from: string; to: string; actor: string; confirm?: boolean }): Promise<{ rel: string; transfer?: 'approved' }>
export async function trash(db, photosDir, o: { rel: string; actor: string }): Promise<{ trashRel: string }>
export async function restore(db, photosDir, o: { trashRel: string; actor: string }): Promise<{ rel: string }>
export async function listTrash(photosDir): Promise<{ trashRel: string; original: string; trashedAt: string; size: number | null }[]>
export async function writeUpload(db, photosDir, o: { dirRel: string; name: string; bytes: Buffer | NodeJS.ReadableStream; size: number; actor: string }): Promise<Entry>
export async function purgeTrash(photosDir, olderThanMs = 30 * 864e5): Promise<number>
export const filesHandlers: Handlers   // trash_purge
```
- Rules: `rel` normalised (`a/b`), root is `''`. `reserved` if any segment is in `.draft/.cache/.trash` or the leaf is `client.json`/`project.json` (for mkdir, move-to, upload, trash). `move` of a folder that is a project into a different client folder: without `confirm` → `FilesError('needs_confirm')`; with confirm → perform the rename, `rescan`, then `approveTransfer`. Any other move/rename → rename then `rescan` (identity survives by id). Renaming a file inside a project's culling/finals folder is allowed but logs event `media_renamed_externally` with old/new names (the remap command in Task 2 relinks). `trash` moves to `.trash/<ISO timestamp>__<original rel with / replaced by ␣>`; keeps a sidecar `.trash/<same>.json` `{ original, trashedAt, actor }`; then `rescan` (rows become unavailable). `restore` moves back (refuses if target exists), `rescan`. `writeUpload`: name sanitised (`basename`, no leading dot), size limit by sniffed kind (media vs attachment), writes `<name>.part` then renames; refuses reserved dirs; unrecognised types are kept but flagged `media: null`. `purgeTrash` deletes entries older than 30 days by their sidecar timestamp.

- [ ] **Step 1: Write the failing test**

`tests/domain/files.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdir as fsMkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { makeJpeg } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { projects, clients, photos, events } from '../../src/server/db/schema.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia } from '../../src/server/fs/photos.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';
import { listDir, mkdir, move, trash, restore, listTrash, writeUpload, purgeTrash, FilesError } from '../../src/server/domain/files.js';

async function seed() {
  const root = await tmpDir(); const db = openDb(':memory:'); migrate(db);
  const c = defaultClientJson('Smith'); const o = defaultClientJson('Other'); const p = defaultProjectJson('Wedding');
  await fsMkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true }); await fsMkdir(join(root, 'Clients/Other'), { recursive: true }); await fsMkdir(join(root, 'Marketing'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), c); await writeJsonAtomic(join(root, 'Clients/Other/client.json'), o);
  await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), p);
  await makeJpeg(join(root, 'Clients/Smith/Wedding/raw/a.jpg')); await writeFile(join(root, 'Marketing/notes.txt'), 'hi');
  await rescan(db, root); await indexProjectMedia(db, root, p.id!);
  return { root, db, pid: p.id!, cid: c.id!, oid: o.id! };
}

describe('files domain', () => {
  it('lists the root with kinds and badges', async () => {
    const { root, db } = await seed();
    const r = await listDir(db, root, '');
    expect(r.entries.map((e) => [e.name, e.kind])).toEqual([['Clients', 'dir'], ['Marketing', 'dir']]);
    const cl = await listDir(db, root, 'Clients');
    expect(cl.entries.find((e) => e.name === 'Smith')).toMatchObject({ kind: 'client', id: expect.any(String) });
    const sm = await listDir(db, root, 'Clients/Smith');
    expect(sm.entries.find((e) => e.name === 'Wedding')).toMatchObject({ kind: 'project', badge: { state: 'culling', available: true } });
    expect(sm.entries.find((e) => e.name === 'client.json')).toBeUndefined(); // metadata files are not listed
    const raw = await listDir(db, root, 'Clients/Smith/Wedding/raw');
    expect(raw.entries[0]).toMatchObject({ name: 'a.jpg', kind: 'file', media: 'photo' });
  });
  it('refuses reserved paths and traversal everywhere', async () => {
    const { root, db } = await seed();
    await expect(mkdir(db, root, 'Clients/Smith/Wedding/.cache/x', 'o')).rejects.toMatchObject({ code: 'reserved' });
    await expect(mkdir(db, root, '../x', 'o')).rejects.toThrow();
    await expect(writeUpload(db, root, { dirRel: 'Clients/Smith', name: 'project.json', bytes: Buffer.from('{}'), size: 2, actor: 'o' })).rejects.toMatchObject({ code: 'reserved' });
    await expect(writeUpload(db, root, { dirRel: '.trash', name: 'x.txt', bytes: Buffer.from('x'), size: 1, actor: 'o' })).rejects.toMatchObject({ code: 'reserved' });
    await expect(move(db, root, { from: 'Marketing/notes.txt', to: 'Clients/Smith/Wedding/.draft/notes.txt', actor: 'o' })).rejects.toMatchObject({ code: 'reserved' });
    await expect(trash(db, root, { rel: 'Clients/Smith/client.json', actor: 'o' })).rejects.toMatchObject({ code: 'reserved' });
  });
  it('mkdir, rename within a client, and a plain file move keep project identity', async () => {
    const { root, db, pid } = await seed();
    expect((await mkdir(db, root, 'Marketing/Instagram', 'o')).kind).toBe('dir');
    await expect(mkdir(db, root, 'Marketing/Instagram', 'o')).rejects.toMatchObject({ code: 'exists' });
    await move(db, root, { from: 'Clients/Smith/Wedding', to: 'Clients/Smith/Wedding 2026', actor: 'o' });
    const row = db.select().from(projects).where(eq(projects.id, pid)).get()!;
    expect(row.folderPath).toBe('Clients/Smith/Wedding 2026'); expect(row.available).toBe(true);
    expect(db.select().from(photos).where(eq(photos.projectId, pid)).all()).toHaveLength(1);
    await move(db, root, { from: 'Marketing/notes.txt', to: 'Clients/Smith/Wedding 2026/notes.txt', actor: 'o' });
    expect((await stat(join(root, 'Clients/Smith/Wedding 2026/notes.txt'))).isFile()).toBe(true);
  });
  it('a cross-client project move needs confirmation, then transfers with the same id', async () => {
    const { root, db, pid, oid } = await seed();
    await expect(move(db, root, { from: 'Clients/Smith/Wedding', to: 'Clients/Other/Wedding', actor: 'o' })).rejects.toMatchObject({ code: 'needs_confirm' });
    expect((await stat(join(root, 'Clients/Smith/Wedding'))).isDirectory()).toBe(true); // nothing moved
    const r = await move(db, root, { from: 'Clients/Smith/Wedding', to: 'Clients/Other/Wedding', actor: 'o', confirm: true });
    expect(r.transfer).toBe('approved');
    const row = db.select().from(projects).where(eq(projects.id, pid)).get()!;
    expect(row.clientId).toBe(oid); expect(row.available).toBe(true); expect(row.transferPending).toBe(false);
  });
  it('trash keeps rows and ids; restore brings them back; purge removes old entries', async () => {
    const { root, db, pid } = await seed();
    const t = await trash(db, root, { rel: 'Clients/Smith/Wedding', actor: 'o' });
    expect(t.trashRel).toMatch(/^\.trash\//);
    let row = db.select().from(projects).where(eq(projects.id, pid)).get()!;
    expect(row.available).toBe(false);
    expect(db.select().from(photos).where(eq(photos.projectId, pid)).all()).toHaveLength(1);
    const list = await listTrash(root);
    expect(list).toEqual([expect.objectContaining({ trashRel: t.trashRel, original: 'Clients/Smith/Wedding' })]);
    await restore(db, root, { trashRel: t.trashRel, actor: 'o' });
    row = db.select().from(projects).where(eq(projects.id, pid)).get()!;
    expect(row.available).toBe(true); expect(row.folderPath).toBe('Clients/Smith/Wedding');
    await trash(db, root, { rel: 'Marketing/notes.txt', actor: 'o' });
    expect(await purgeTrash(root, 0)).toBe(1);
    expect(await listTrash(root)).toEqual([]);
    expect(db.select().from(events).all().filter((e) => ['trashed', 'restored'].includes(e.type))).toHaveLength(3);
  });
  it('uploads under limits with sanitised names; oversize and executables are refused', async () => {
    const { root, db } = await seed();
    const e = await writeUpload(db, root, { dirRel: 'Marketing', name: '../evil.txt', bytes: Buffer.from('x'), size: 1, actor: 'o' });
    expect(e.name).toBe('evil.txt'); expect((await stat(join(root, 'Marketing/evil.txt'))).size).toBe(1);
    await expect(writeUpload(db, root, { dirRel: 'Marketing', name: 'big.bin', bytes: Buffer.alloc(10), size: 3 * 1024 ** 3, actor: 'o' })).rejects.toMatchObject({ code: 'too_large' });
    await expect(writeUpload(db, root, { dirRel: 'Marketing', name: 'run.sh', bytes: Buffer.from('#!/bin/sh'), size: 9, actor: 'o' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(writeUpload(db, root, { dirRel: 'Marketing', name: 'evil.txt', bytes: Buffer.from('y'), size: 1, actor: 'o' })).rejects.toMatchObject({ code: 'exists' });
    expect((await readdir(join(root, 'Marketing'))).filter((n) => n.endsWith('.part'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/domain/files.test.ts` → missing module.

- [ ] **Step 3: Implement**

`src/server/domain/files.ts`:
```ts
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
const norm = (rel: string) => posix.normalize(rel.replace(/\\/g, '/')).replace(/^\.\/?/, '').replace(/^\/+|\/+$/g, '');
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
    if (d.name.startsWith('.') || META.has(d.name)) continue;
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

function projectAt(db: Db, rel: string) { return db.select().from(projects).where(eq(projects.folderPath, rel)).get() ?? null; }
const clientOf = (rel: string) => { const m = rel.match(/^Clients\/([^/]+)\//); return m ? `Clients/${m[1]}` : null; };

export async function move(db: Db, photosDir: string, o: { from: string; to: string; actor: string; confirm?: boolean }): Promise<{ rel: string; transfer?: 'approved' }> {
  const from = norm(o.from); const to = norm(o.to); if (!from || !to || from === to) throw new FilesError('invalid');
  guard(from); guard(to);
  const fromAbs = await resolveInside(photosDir, from); const toAbs = await resolveInside(photosDir, to);
  if (!(await exists(fromAbs))) throw new FilesError('not_found');
  if (await exists(toAbs)) throw new FilesError('exists');
  const proj = projectAt(db, from);
  const crossClient = !!proj && clientOf(from) !== clientOf(to);
  if (crossClient && !o.confirm) throw new FilesError('needs_confirm');
  await fsMkdir(dirname(toAbs), { recursive: true });
  await rename(fromAbs, toAbs);
  db.insert(events).values({ projectId: proj?.id ?? null, actor: o.actor, type: 'moved', payload: { from, to } }).run();
  // a media file renamed inside a project: the row shows missing + new until an admin remaps it
  const owner = db.select().from(projects).all().find((p) => from.startsWith(p.folderPath + '/'));
  if (owner && !proj) { const meta = ProjectJson.parse(owner.metadataJson); const inMedia = [meta.folders.culling, meta.folders.finals].some((f) => from.startsWith(`${owner.folderPath}/${f}/`)); if (inMedia) db.insert(events).values({ projectId: owner.id, actor: o.actor, type: 'media_renamed_externally', payload: { from: from.slice(owner.folderPath.length + 1), to: to.startsWith(owner.folderPath + '/') ? to.slice(owner.folderPath.length + 1) : null } }).run(); }
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

export async function listTrash(photosDir: string) {
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

export async function writeUpload(db: Db, photosDir: string, o: { dirRel: string; name: string; bytes: Buffer | NodeJS.ReadableStream; size: number; actor: string }): Promise<Entry> {
  const dirRel = norm(o.dirRel); if (dirRel) guard(dirRel, true);
  const name = basename(o.name.replace(/\\/g, '/')).replace(/^\.+/, '').trim(); if (!name || META.has(name)) throw new FilesError(META.has(name) ? 'reserved' : 'invalid');
  const ext = posix.extname(name).toLowerCase(); if (EXEC.has(ext)) throw new FilesError('unsupported');
  const rel = dirRel ? `${dirRel}/${name}` : name; guard(rel);
  const abs = await resolveInside(photosDir, rel); if (await exists(abs)) throw new FilesError('exists');
  const dirAbs = dirname(abs); if (!(await exists(dirAbs))) throw new FilesError('not_found');
  const lim = limits(db); const isMedia = ['.jpg', '.jpeg', '.png', '.heic', '.mp4', '.mov', '.m4v', '.nef', '.cr2', '.cr3', '.arw', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw'].includes(ext);
  if (o.size > (isMedia ? lim.media : lim.attachment)) throw new FilesError('too_large');
  const part = `${abs}.part`;
  try {
    if (Buffer.isBuffer(o.bytes)) await writeFile(part, o.bytes); else await pipeline(o.bytes, createWriteStream(part));
    await rename(part, abs);
  } catch (e) { await unlink(part).catch(() => {}); throw e; }
  const s = await stat(abs); const sn = await sniff(abs).catch(() => null);
  db.insert(events).values({ actor: o.actor, type: 'uploaded', payload: { rel, size: s.size } }).run();
  return { name, rel, kind: 'file', size: s.size, mtime: s.mtime.toISOString(), media: sn?.kind ?? null };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/domain/files.test.ts` → 6 passed. Also `tests/fs` still green.

- [ ] **Step 5: Commit**
```bash
git add src/server/domain/files.ts tests/domain/files.test.ts
git commit -m "feat: files domain: list, mkdir, move with identity rules, trash/restore/purge, uploads under the write policy"
```

---

### Task 2: Identity conflict resolution — adopt a duplicate, remap renamed media

**Files:**
- Create: `src/server/domain/identity.ts`, `tests/domain/identity.test.ts`

**Interfaces:**
```ts
export class IdentityError extends Error { code: 'not_duplicate' | 'not_found' | 'mismatch' }
export async function adoptDuplicate(db, photosDir, o: { rel: string; actor: string }): Promise<{ id: string }>
   // rel must be a folder currently reported as duplicate_id; writes a new id (and for clients also new id), clears machine fields to defaults, rescans
export function remapPhoto(db, o: { projectId: string; missingPhotoId: string; newPhotoId: string; actor: string }): void
   // both rows in the project, same stage; missing row must be missing=true, new row must have no picks/comments; moves relPath+checksum+dims from new onto missing row, deletes the new row, records photo_remapped
```

- [ ] **Step 1: Write the failing test**

`tests/domain/identity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdir, rename, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { makeJpeg } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { projects, photos, picks, comments } from '../../src/server/db/schema.js';
import { rescan, currentIssues } from '../../src/server/fs/index.js';
import { indexProjectMedia } from '../../src/server/fs/photos.js';
import { writeJsonAtomic, readJson } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson, ProjectJson } from '../../src/server/fs/schemas.js';
import { adoptDuplicate, remapPhoto, IdentityError } from '../../src/server/domain/identity.js';

async function seed() {
  const root = await tmpDir(); const db = openDb(':memory:'); migrate(db);
  const p = defaultProjectJson('Wedding'); p.allowance = { included: 5, extraPrice: 0, slots: 5 };
  await mkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), { ...defaultClientJson('Smith'), emails: ['s@x.com'] });
  await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), p);
  await makeJpeg(join(root, 'Clients/Smith/Wedding/raw/a.jpg'));
  await rescan(db, root); await indexProjectMedia(db, root, p.id!);
  return { root, db, pid: p.id! };
}

describe('identity resolution', () => {
  it('adopts a duplicated project folder with a fresh id and no transactional state', async () => {
    const { root, db, pid } = await seed();
    const a = db.select().from(photos).get()!;
    db.insert(picks).values({ projectId: pid, photoId: a.id, round: 1, byEmail: 's@x.com', state: 'confirmed' }).run();
    await cp(join(root, 'Clients/Smith/Wedding'), join(root, 'Clients/Smith/Wedding copy'), { recursive: true });
    await rescan(db, root);
    expect(currentIssues().filter((i) => i.kind === 'duplicate_id')).toHaveLength(2);
    await expect(adoptDuplicate(db, root, { rel: 'Clients/Smith/Wedding', actor: 'o' })).resolves.toBeTruthy(); // either side may be adopted
    // the adopted side has a new id, default machine fields, and no picks; the other keeps the original id and picks
    const file = await readJson(join(root, 'Clients/Smith/Wedding/project.json'), ProjectJson);
    expect(file.ok && file.data.id).not.toBe(pid); expect(file.ok && file.data.allowance.included).toBe(5); // human-ish allowance.included kept
    expect(file.ok && file.data.state.production).toBe('not_started');
    const rows = db.select().from(projects).all(); expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === pid)?.available).toBe(true);
    expect(db.select().from(picks).all()).toHaveLength(1);
    expect(currentIssues()).toEqual([]);
    await expect(adoptDuplicate(db, root, { rel: 'Clients/Smith/Wedding', actor: 'o' })).rejects.toMatchObject({ code: 'not_duplicate' });
  });
  it('remaps a renamed RAW onto its missing row, keeping picks and comments', async () => {
    const { root, db, pid } = await seed();
    const a = db.select().from(photos).get()!;
    db.insert(picks).values({ projectId: pid, photoId: a.id, round: 1, byEmail: 's@x.com', state: 'confirmed' }).run();
    db.insert(comments).values({ id: 'c1', photoId: a.id, author: 's@x.com', stage: 'culling', text: 'hi' }).run();
    await rename(join(root, 'Clients/Smith/Wedding/raw/a.jpg'), join(root, 'Clients/Smith/Wedding/raw/z.jpg'));
    await indexProjectMedia(db, root, pid);
    const rows = db.select().from(photos).all(); expect(rows).toHaveLength(2);
    const fresh = rows.find((r) => r.relPath === 'raw/z.jpg')!;
    expect(() => remapPhoto(db, { projectId: pid, missingPhotoId: fresh.id, newPhotoId: a.id, actor: 'o' })).toThrow(IdentityError); // wrong direction
    remapPhoto(db, { projectId: pid, missingPhotoId: a.id, newPhotoId: fresh.id, actor: 'o' });
    const after = db.select().from(photos).all(); expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: a.id, relPath: 'raw/z.jpg', missing: false });
    expect(db.select().from(picks).where(eq(picks.photoId, a.id)).all()).toHaveLength(1);
    expect(db.select().from(comments).where(eq(comments.photoId, a.id)).all()).toHaveLength(1);
    await indexProjectMedia(db, root, pid); expect(db.select().from(photos).all()).toHaveLength(1); // stable afterwards
  });
});
```

- [ ] **Step 2: Run to verify it fails** — missing module.

- [ ] **Step 3: Implement**

`src/server/domain/identity.ts`:
```ts
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { photos, picks, comments, events, jobs } from '../db/schema.js';
import { rescan, currentIssues } from '../fs/index.js';
import { readJson, writeJsonAtomic } from '../fs/json.js';
import { ClientJson, ProjectJson, splitFields } from '../fs/schemas.js';
import { newId } from '../fs/ids.js';
import { enqueue } from '../jobs/queue.js';

export class IdentityError extends Error { constructor(public code: 'not_duplicate' | 'not_found' | 'mismatch') { super(code); this.name = 'IdentityError'; } }

/** The copy at `rel` becomes its own client or project: new id, default machine fields, human fields kept, no picks or grants. */
export async function adoptDuplicate(db: Db, photosDir: string, o: { rel: string; actor: string }): Promise<{ id: string }> {
  const issue = currentIssues().find((i) => i.kind === 'duplicate_id' && i.path === o.rel);
  if (!issue) throw new IdentityError('not_duplicate');
  const depth = o.rel.split('/').length; // Clients/<client> = 2, Clients/<client>/<project> = 3
  const id = newId();
  if (depth === 3) {
    const r = await readJson(join(photosDir, o.rel, 'project.json'), ProjectJson); if (!r.ok) throw new IdentityError('not_found');
    const fresh = ProjectJson.parse({ schemaVersion: 1, id, title: r.data.title });
    const human = splitFields(r.data).human; const merged = { ...fresh, ...human, id, allowance: { ...fresh.allowance, included: r.data.allowance.included, extraPrice: r.data.allowance.extraPrice, slots: r.data.allowance.included } };
    await writeJsonAtomic(join(photosDir, o.rel, 'project.json'), merged);
  } else if (depth === 2) {
    const r = await readJson(join(photosDir, o.rel, 'client.json'), ClientJson); if (!r.ok) throw new IdentityError('not_found');
    await writeJsonAtomic(join(photosDir, o.rel, 'client.json'), { ...r.data, id, stripeCustomerId: null, listmonkSubscriberId: null });
  } else throw new IdentityError('not_found');
  db.insert(events).values({ actor: o.actor, type: 'duplicate_adopted', payload: { rel: o.rel, id, previousId: issue.id ?? null } }).run();
  await rescan(db, photosDir);
  if (depth === 3) enqueue(db, { kind: 'index_project', payload: { projectId: id }, idempotencyKey: `index:${id}:adopt` });
  return { id };
}

/** Explicit admin relink after an external rename: the missing row takes over the new file; picks and comments stay on the original id. */
export function remapPhoto(db: Db, o: { projectId: string; missingPhotoId: string; newPhotoId: string; actor: string }): void {
  db.transaction((tx) => {
    const miss = tx.select().from(photos).where(and(eq(photos.id, o.missingPhotoId), eq(photos.projectId, o.projectId))).get();
    const fresh = tx.select().from(photos).where(and(eq(photos.id, o.newPhotoId), eq(photos.projectId, o.projectId))).get();
    if (!miss || !fresh) throw new IdentityError('not_found');
    if (!miss.missing || fresh.missing || miss.stage !== fresh.stage) throw new IdentityError('mismatch');
    if (tx.select().from(picks).where(eq(picks.photoId, fresh.id)).get() || tx.select().from(comments).where(eq(comments.photoId, fresh.id)).get()) throw new IdentityError('mismatch');
    tx.delete(photos).where(eq(photos.id, fresh.id)).run();
    tx.update(photos).set({ relPath: fresh.relPath, draftRelPath: fresh.draftRelPath, checksum: fresh.checksum, width: fresh.width, height: fresh.height, capturedAt: fresh.capturedAt, missing: false }).where(eq(photos.id, miss.id)).run();
    tx.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'photo_remapped', payload: { photoId: miss.id, from: miss.relPath, to: fresh.relPath } }).run();
  });
}
export { jobs };
```
Remove the trailing `export { jobs };` and its import. Register an `index_project` handler in `src/server/fs/photos.ts` (`makePreviewHandlers` gains `index_project: async ({ projectId }) => indexProjectMedia(db, photosDir, projectId)`), so adoption indexes the new project's media through the queue.

- [ ] **Step 4: Run** — `npx vitest run tests/domain/identity.test.ts tests/fs` → green.

- [ ] **Step 5: Commit**
```bash
git add src/server/domain/identity.ts src/server/fs/photos.ts tests/domain/identity.test.ts
git commit -m "feat: identity resolution: adopt a duplicated folder, remap a renamed media file"
```

---

### Task 3: Admin domain — clients, projects, details, price, shot, order, cover, shared files, events, insights

**Files:**
- Create: `src/server/domain/admin.ts`, `tests/domain/admin.test.ts`

**Interfaces:**
```ts
export class AdminError extends Error { code: 'invalid' | 'exists' | 'not_found' | 'guard' }
export async function createClient(db, photosDir, o: { name: string; emails: string[]; actor: string }): Promise<{ id: string; folderPath: string }>
export async function updateClient(db, photosDir, o: { clientId: string; patch: Partial<Pick<ClientJson,'name'|'emails'|'phone'|'notes'>>; actor: string }): Promise<void>
export async function createProject(db, photosDir, o: { clientId: string; title: string; date?: string | null; included?: number; extraPrice?: number; assignedTo?: string | null; actor: string }): Promise<{ id: string; folderPath: string }>
export const HUMAN_PATCH = ['title','date','assignedTo','folders','downloads','comments','notifyOnPublish','music','cover','expiresAt','offers','portfolioRelease','showOffers','package'] as const
export async function updateProjectHuman(db, photosDir, o: { projectId: string; patch: Partial<ProjectJson>; actor: string }): Promise<ProjectJson>   // machine keys in patch → AdminError('invalid')
export async function setExtraPrice(db, photosDir, o: { projectId: string; extraPrice: number; actor: string }): Promise<void>
export async function markShot(db, photosDir, o: { projectId: string; actor: string }): Promise<void>   // guard: not_started → shot
export function reorderPhotos(db, o: { projectId: string; ids: string[]; actor: string }): void         // finals only; ids must be that project's finals
export async function setCover(db, photosDir, o: { projectId: string; photoId: string | null; actor: string }): Promise<void>
export async function setSharedFiles(db, photosDir, o: { projectId: string; rel: string; shared: boolean; actor: string }): Promise<string[]>  // metadata.sharedFiles (human list of project-relative paths)
export function projectEvents(db, projectId, limit = 100): EventRow[]
export function projectInsights(db, projectId): { views: number; uniqueVisitors: number; byDay: { day: string; views: number; picks: number; comments: number }[]; visitors: { actor: string; views: number; lastSeen: string }[] }
```
- `createClient`: folder `Clients/<safe name>` (collide → `name (2)`), `client.json` via `defaultClientJson`, `rescan`. `createProject`: folder under the client's folder, `project.json` with allowance, `raw/` and `finals/` created, `rescan`. `updateProjectHuman`: merges into `metadataJson`, bumps nothing machine, writes projection, event `project_updated` with the changed keys. `setExtraPrice` → `allowance.extraPrice`, event `price_changed`, projection. `markShot`: `productionState` `not_started` → `shot`, `stateVersion+1`, event, projection; otherwise `AdminError('guard')`. `sharedFiles`: add `sharedFiles: z.array(z.string()).default([])` to `ProjectJson` (human field).

- [ ] **Step 1: Write the failing test**

`tests/domain/admin.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { makeJpeg } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { projects, clients, photos, events } from '../../src/server/db/schema.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia } from '../../src/server/fs/photos.js';
import { readJson } from '../../src/server/fs/json.js';
import { ProjectJson } from '../../src/server/fs/schemas.js';
import { createClient, createProject, updateClient, updateProjectHuman, setExtraPrice, markShot, reorderPhotos, setCover, setSharedFiles, projectEvents, projectInsights, AdminError } from '../../src/server/domain/admin.js';

async function fresh() { const root = await tmpDir(); await mkdir(join(root, 'Clients'), { recursive: true }); const db = openDb(':memory:'); migrate(db); await rescan(db, root); return { root, db }; }

describe('admin domain', () => {
  it('creates a client and a project on disk and in the database', async () => {
    const { root, db } = await fresh();
    const c = await createClient(db, root, { name: 'Smith / Family', emails: ['S@x.com'], actor: 'o' });
    expect(c.folderPath).toBe('Clients/Smith - Family');
    const c2 = await createClient(db, root, { name: 'Smith / Family', emails: [], actor: 'o' });
    expect(c2.folderPath).toBe('Clients/Smith - Family (2)');
    const p = await createProject(db, root, { clientId: c.id, title: 'Wedding', date: '2026-06-14', included: 40, extraPrice: 1500, actor: 'o' });
    expect(p.folderPath).toBe('Clients/Smith - Family/Wedding');
    expect((await stat(join(root, p.folderPath, 'raw'))).isDirectory()).toBe(true);
    const row = db.select().from(projects).where(eq(projects.id, p.id)).get()!;
    expect(row.clientId).toBe(c.id); expect(row.date).toBe('2026-06-14');
    expect(db.select().from(clients).where(eq(clients.id, c.id)).get()?.emails).toEqual(['s@x.com']);
    await expect(createProject(db, root, { clientId: 'nope', title: 'X', actor: 'o' })).rejects.toMatchObject({ code: 'not_found' });
    await updateClient(db, root, { clientId: c.id, patch: { name: 'Smiths', emails: ['a@x.com', 'B@x.com'] }, actor: 'o' });
    expect(db.select().from(clients).where(eq(clients.id, c.id)).get()).toMatchObject({ name: 'Smiths', emails: ['a@x.com', 'b@x.com'], folderPath: 'Clients/Smith - Family' });
  });
  it('updates human fields only, changes price, marks shot once', async () => {
    const { root, db } = await fresh();
    const c = await createClient(db, root, { name: 'A', emails: [], actor: 'o' });
    const p = await createProject(db, root, { clientId: c.id, title: 'W', actor: 'o' });
    const meta = await updateProjectHuman(db, root, { projectId: p.id, patch: { title: 'W2', downloads: 'none', comments: { culling: false, finals: true }, assignedTo: 'sam@x' }, actor: 'o' });
    expect(meta.title).toBe('W2'); expect(meta.downloads).toBe('none');
    await expect(updateProjectHuman(db, root, { projectId: p.id, patch: { allowance: { included: 99, extraPrice: 0, slots: 99 } } as never, actor: 'o' })).rejects.toMatchObject({ code: 'invalid' });
    await setExtraPrice(db, root, { projectId: p.id, extraPrice: 2500, actor: 'o' });
    const file = await readJson(join(root, p.folderPath, 'project.json'), ProjectJson);
    expect(file.ok && file.data.allowance.extraPrice).toBe(2500); expect(file.ok && file.data.title).toBe('W2');
    await markShot(db, root, { projectId: p.id, actor: 'o' });
    const row = db.select().from(projects).where(eq(projects.id, p.id)).get()!;
    expect(row.productionState).toBe('shot'); expect(row.stateVersion).toBe(2);
    await expect(markShot(db, root, { projectId: p.id, actor: 'o' })).rejects.toMatchObject({ code: 'guard' });
    expect(projectEvents(db, p.id).map((e) => e.type)).toEqual(expect.arrayContaining(['project_updated', 'price_changed', 'production_changed']));
  });
  it('reorders finals, sets a cover, toggles shared files', async () => {
    const { root, db } = await fresh();
    const c = await createClient(db, root, { name: 'A', emails: [], actor: 'o' });
    const p = await createProject(db, root, { clientId: c.id, title: 'W', actor: 'o' });
    for (const n of ['a', 'b', 'c']) await makeJpeg(join(root, p.folderPath, `finals/${n}.jpg`));
    await makeJpeg(join(root, p.folderPath, 'raw/r.jpg')); await writeFile(join(root, p.folderPath, 'Timeline.pdf'), '%PDF-1.4');
    await indexProjectMedia(db, root, p.id);
    const finals = db.select().from(photos).where(eq(photos.projectId, p.id)).all().filter((x) => x.stage === 'final').sort((x, y) => x.relPath.localeCompare(y.relPath));
    const raw = db.select().from(photos).where(eq(photos.projectId, p.id)).all().find((x) => x.stage === 'culling')!;
    reorderPhotos(db, { projectId: p.id, ids: [finals[2]!.id, finals[0]!.id, finals[1]!.id], actor: 'o' });
    const order = db.select().from(photos).where(eq(photos.projectId, p.id)).all().filter((x) => x.stage === 'final').sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.relPath);
    expect(order).toEqual(['finals/c.jpg', 'finals/a.jpg', 'finals/b.jpg']);
    expect(() => reorderPhotos(db, { projectId: p.id, ids: [raw.id], actor: 'o' })).toThrow(AdminError);
    await setCover(db, root, { projectId: p.id, photoId: finals[1]!.id, actor: 'o' });
    expect((await readJson(join(root, p.folderPath, 'project.json'), ProjectJson)).ok && ProjectJson.parse(db.select().from(projects).where(eq(projects.id, p.id)).get()!.metadataJson).cover).toBe('finals/b.jpg');
    expect(await setSharedFiles(db, root, { projectId: p.id, rel: 'Timeline.pdf', shared: true, actor: 'o' })).toEqual(['Timeline.pdf']);
    await expect(setSharedFiles(db, root, { projectId: p.id, rel: 'raw/r.jpg', shared: true, actor: 'o' })).rejects.toMatchObject({ code: 'invalid' }); // media folders are not attachments
    await expect(setSharedFiles(db, root, { projectId: p.id, rel: 'nope.pdf', shared: true, actor: 'o' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await setSharedFiles(db, root, { projectId: p.id, rel: 'Timeline.pdf', shared: false, actor: 'o' })).toEqual([]);
  });
  it('derives insights from events', async () => {
    const { root, db } = await fresh();
    const c = await createClient(db, root, { name: 'A', emails: [], actor: 'o' });
    const p = await createProject(db, root, { clientId: c.id, title: 'W', actor: 'o' });
    db.insert(events).values([
      { projectId: p.id, actor: 's@x', type: 'viewed', payload: {}, at: '2026-06-01T10:00:00Z' }, { projectId: p.id, actor: 's@x', type: 'viewed', payload: {}, at: '2026-06-02T10:00:00Z' },
      { projectId: p.id, actor: 't@x', type: 'viewed', payload: {}, at: '2026-06-02T11:00:00Z' }, { projectId: p.id, actor: 's@x', type: 'picked', payload: {}, at: '2026-06-02T11:05:00Z' },
      { projectId: p.id, actor: 's@x', type: 'commented', payload: {}, at: '2026-06-03T09:00:00Z' },
    ]).run();
    const i = projectInsights(db, p.id);
    expect(i.views).toBe(3); expect(i.uniqueVisitors).toBe(2);
    expect(i.byDay).toEqual([{ day: '2026-06-01', views: 1, picks: 0, comments: 0 }, { day: '2026-06-02', views: 2, picks: 1, comments: 0 }, { day: '2026-06-03', views: 0, picks: 0, comments: 1 }]);
    expect(i.visitors[0]).toMatchObject({ actor: 's@x', views: 2 });
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

Add to `ProjectJson` in `src/server/fs/schemas.ts`: `sharedFiles: z.array(z.string()).default([]),` (human field).

`src/server/domain/admin.ts`:
```ts
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, projects, photos, events } from '../db/schema.js';
import { rescan, writeProjection } from '../fs/index.js';
import { writeJsonAtomic } from '../fs/json.js';
import { ClientJson, ProjectJson, MACHINE_FIELDS, defaultClientJson, defaultProjectJson } from '../fs/schemas.js';
import { isReserved } from '../fs/paths.js';

export class AdminError extends Error { constructor(public code: 'invalid' | 'exists' | 'not_found' | 'guard') { super(code); this.name = 'AdminError'; } }
export type EventRow = typeof events.$inferSelect;

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Untitled';
async function freeFolder(base: string, name: string): Promise<string> {
  for (let i = 1; i < 1000; i++) { const n = i === 1 ? name : `${name} (${i})`; if (!(await stat(join(base, n)).then(() => true, () => false))) return n; }
  throw new AdminError('exists');
}
const proj = (db: Db, id: string) => { const r = db.select().from(projects).where(eq(projects.id, id)).get(); if (!r) throw new AdminError('not_found'); return r; };
const emails = (xs: string[]) => [...new Set(xs.map((e) => e.trim().toLowerCase()).filter(Boolean))];

export async function createClient(db: Db, photosDir: string, o: { name: string; emails: string[]; actor: string }) {
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
  const { readJson } = await import('../fs/json.js'); const cur = await readJson(file, ClientJson); if (!cur.ok) throw new AdminError('not_found');
  const next = { ...cur.data, ...o.patch, emails: emails(o.patch.emails ?? cur.data.emails) };
  if (!next.name?.trim()) throw new AdminError('invalid');
  await writeJsonAtomic(file, next);
  db.insert(events).values({ actor: o.actor, type: 'client_updated', payload: { id: o.clientId, keys: Object.keys(o.patch) } }).run();
  await rescan(db, photosDir);
}

export async function createProject(db: Db, photosDir: string, o: { clientId: string; title: string; date?: string | null; included?: number; extraPrice?: number; assignedTo?: string | null; actor: string }) {
  const c = db.select().from(clients).where(eq(clients.id, o.clientId)).get(); if (!c) throw new AdminError('not_found');
  if (!o.title.trim()) throw new AdminError('invalid');
  const base = join(photosDir, c.folderPath); const folder = await freeFolder(base, safeName(o.title)); const folderPath = `${c.folderPath}/${folder}`;
  const p = defaultProjectJson(o.title.trim()); p.date = o.date ?? null; p.assignedTo = o.assignedTo ?? null;
  const inc = o.included ?? 0; p.allowance = { included: inc, extraPrice: o.extraPrice ?? 0, slots: inc };
  await mkdir(join(base, folder, 'raw'), { recursive: true }); await mkdir(join(base, folder, 'finals'), { recursive: true }); await mkdir(join(base, folder, 'documents'), { recursive: true });
  await writeJsonAtomic(join(base, folder, 'project.json'), p);
  db.insert(events).values({ projectId: p.id, actor: o.actor, type: 'project_created', payload: { folderPath } }).run();
  await rescan(db, photosDir);
  return { id: p.id!, folderPath };
}

export const HUMAN_PATCH = ['title', 'date', 'assignedTo', 'folders', 'downloads', 'comments', 'notifyOnPublish', 'music', 'cover', 'expiresAt', 'offers', 'portfolioRelease', 'showOffers', 'package', 'sharedFiles'] as const;

export async function updateProjectHuman(db: Db, photosDir: string, o: { projectId: string; patch: Partial<ProjectJson>; actor: string }): Promise<ProjectJson> {
  const keys = Object.keys(o.patch);
  if (keys.some((k) => (MACHINE_FIELDS as readonly string[]).includes(k) || !(HUMAN_PATCH as readonly string[]).includes(k))) throw new AdminError('invalid');
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
  if (o.ids.some((id) => !set.has(id)) || new Set(o.ids).size !== o.ids.length) throw new AdminError('invalid');
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

export async function setSharedFiles(db: Db, photosDir: string, o: { projectId: string; rel: string; shared: boolean; actor: string }): Promise<string[]> {
  const row = proj(db, o.projectId); const meta = ProjectJson.parse(row.metadataJson);
  const rel = o.rel.replace(/^\/+/, '');
  if (!rel || rel.includes('..') || isReserved(rel) || [meta.folders.culling, meta.folders.finals].some((f) => rel === f || rel.startsWith(f + '/')) || rel === 'project.json') throw new AdminError('invalid');
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
    if (!['viewed', 'picked', 'unpicked', 'commented'].includes(e.type)) continue;
    const d = byDay.get(day(e.at)) ?? { day: day(e.at), views: 0, picks: 0, comments: 0 }; byDay.set(d.day, d);
    if (e.type === 'viewed') { d.views++; const v = visitors.get(e.actor) ?? { actor: e.actor, views: 0, lastSeen: e.at }; v.views++; if (e.at > v.lastSeen) v.lastSeen = e.at; visitors.set(e.actor, v); }
    if (e.type === 'picked') d.picks++; if (e.type === 'commented') d.comments++;
  }
  const views = rows.filter((e) => e.type === 'viewed').length;
  return { views, uniqueVisitors: visitors.size, byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)), visitors: [...visitors.values()].sort((a, b) => b.views - a.views) };
}
export { sql };
```
Remove `export { sql };` and the `sql` import; replace the dynamic `await import('../fs/json.js')` with a top-level `readJson` import.

- [ ] **Step 4: Run** — green, including `tests/fs` (schema change) and `tests/domain`.

- [ ] **Step 5: Commit**
```bash
git add src/server/domain/admin.ts src/server/fs/schemas.ts tests/domain/admin.test.ts
git commit -m "feat: admin domain: clients, projects, human-field updates, price, shot, reorder, cover, shared files, events, insights"
```

---

### Task 4: Settings, email delivery test, team, jobs

**Files:**
- Create: `src/server/domain/settings.ts`, `tests/domain/settings.test.ts`

**Interfaces:**
```ts
export const StudioSettings = z.object({ studioName: z.string().min(1), from: z.string().default(''), timezone: z.string().default('UTC'), currency: z.string().length(3).default('usd'), defaultIncluded: z.number().int().min(0).default(0), defaultExtraPrice: z.number().int().min(0).default(0), reviewUrl: z.string().default('') })
export function getStudio(db): StudioSettings                      // from settings keys, studioName from bootstrap
export function setStudio(db, patch: Partial<StudioSettings>, actor): StudioSettings
export function setEmailConfig(db, cfg: EmailConfig, actor): void
export function emailStatus(db, config): { configured: boolean; describe: string | null; lastTest: { jobId, state, lastError, at } | null }
export function sendDeliveryTest(db, o: { to: string; actor: string }): { jobId: string }      // key email:test:<to>:<now>
export class TeamError extends Error { code: 'last_owner' | 'not_found' | 'exists' | 'self' | 'forbidden' }
export function listUsers(db): UserRow[]
export function inviteUser(db, o: { email; role; actor; baseUrl; studio }): UserRow          // creates user, sends admin magic link (key invite:<id>:<now>)
export function updateUser(db, o: { userId; patch: { role?; notifyDownloads?; name? }; actor }): UserRow   // last owner cannot be demoted
export function removeUser(db, o: { userId; actor }): void                                   // last owner cannot be removed; cannot remove self
export function listJobs(db, o: { state?: JobState; limit? }): JobRow[]
export function retryJobById(db, id): JobRow   // any failed/needs_review/done? → only failed or needs_review
```

- [ ] **Step 1: Write the failing test**

`tests/domain/settings.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { users, jobs } from '../../src/server/db/schema.js';
import { loadConfig } from '../../src/server/config.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { makeEmailHandlers } from '../../src/server/email/send.js';
import { memoryTransport } from '../../src/server/email/transport.js';
import { getStudio, setStudio, setEmailConfig, emailStatus, sendDeliveryTest, inviteUser, updateUser, removeUser, listUsers, listJobs, retryJobById, TeamError } from '../../src/server/domain/settings.js';

const config = loadConfig({ DATA_DIR: '/tmp/x', PHOTOS_DIR: '/tmp/y', BASE_URL: 'https://g.example', SESSION_SECRET: 'x'.repeat(32) });
function fresh() { const db = openDb(':memory:'); migrate(db); db.insert(users).values({ id: 'u1', email: 'owner@x', role: 'owner' }).run(); return db; }

describe('settings', () => {
  it('studio settings round-trip with defaults', () => {
    const db = fresh();
    expect(getStudio(db)).toMatchObject({ studioName: 'OpenGallery', currency: 'usd', defaultIncluded: 0 });
    setStudio(db, { studioName: 'Klaus Studio', currency: 'eur', defaultIncluded: 40, timezone: 'Europe/Berlin' }, 'owner@x');
    expect(getStudio(db)).toMatchObject({ studioName: 'Klaus Studio', currency: 'eur', defaultIncluded: 40, timezone: 'Europe/Berlin' });
    expect(() => setStudio(db, { currency: 'x' }, 'owner@x')).toThrow();
  });
  it('email config, status, and a delivery test that reports the job state', async () => {
    const db = fresh();
    expect(emailStatus(db, config)).toMatchObject({ configured: false, lastTest: null });
    setEmailConfig(db, { type: 'smtp', url: 'smtp://u:p@h:587', from: 'S <s@x>' }, 'owner@x');
    expect(emailStatus(db, config)).toMatchObject({ configured: true, describe: 'smtp h:587' });
    const { jobId } = sendDeliveryTest(db, { to: 'owner@x', actor: 'owner@x' });
    expect(emailStatus(db, config).lastTest).toMatchObject({ jobId, state: 'pending' });
    const t = memoryTransport(); await runOnce(db, makeEmailHandlers(() => t, 'g'));
    expect(emailStatus(db, config).lastTest).toMatchObject({ jobId, state: 'done' });
    expect(t.sent[0]).toMatchObject({ to: 'owner@x', subject: expect.stringContaining('email delivery works') });
    await runOnce(db, makeEmailHandlers(() => null, 'g'), Date.now() + 1); // nothing left
    const { jobId: j2 } = sendDeliveryTest(db, { to: 'owner@x', actor: 'owner@x' });
    await runOnce(db, makeEmailHandlers(() => null, 'g'));
    expect(emailStatus(db, config).lastTest).toMatchObject({ jobId: j2, state: 'pending', lastError: expect.stringContaining('no email transport') });
  });
  it('team: invite sends a link, roles guarded, last owner protected, no self-removal', () => {
    const db = fresh();
    const m = inviteUser(db, { email: 'Sam@X', role: 'member', actor: 'owner@x', baseUrl: 'https://g', studio: 'S' });
    expect(m).toMatchObject({ email: 'sam@x', role: 'member' });
    expect(db.select().from(jobs).all().find((j) => j.kind === 'send_email')?.payload).toMatchObject({ to: 'sam@x', template: 'magic_link' });
    expect(() => inviteUser(db, { email: 'sam@x', role: 'member', actor: 'owner@x', baseUrl: 'https://g', studio: 'S' })).toThrow(TeamError);
    expect(listUsers(db)).toHaveLength(2);
    expect(() => updateUser(db, { userId: 'u1', patch: { role: 'member' }, actor: 'owner@x' })).toThrow(/last_owner/);
    expect(() => removeUser(db, { userId: 'u1', actor: 'owner@x' })).toThrow(/last_owner|self/);
    updateUser(db, { userId: m.id, patch: { role: 'owner', notifyDownloads: 'each' }, actor: 'owner@x' });
    updateUser(db, { userId: 'u1', patch: { role: 'member' }, actor: 'owner@x' }); // now allowed: sam is an owner
    expect(() => removeUser(db, { userId: m.id, actor: 'sam@x' })).toThrow(/self/);
    removeUser(db, { userId: 'u1', actor: 'sam@x' });
    expect(listUsers(db).map((u) => u.email)).toEqual(['sam@x']);
    expect(() => removeUser(db, { userId: m.id, actor: 'owner@x' })).toThrow(/last_owner/);
  });
  it('jobs list and retry', async () => {
    const db = fresh();
    sendDeliveryTest(db, { to: 'a@x', actor: 'owner@x' });
    for (let i = 0; i < 3; i++) await runOnce(db, makeEmailHandlers(() => null, 'g'), Date.now() + i * 3600_000);
    expect(listJobs(db, { state: 'failed' })).toHaveLength(1);
    const j = listJobs(db, { state: 'failed' })[0]!;
    expect(retryJobById(db, j.id).state).toBe('pending');
    expect(() => retryJobById(db, j.id)).toThrow(); // not failed any more
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

`src/server/domain/settings.ts`:
```ts
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users, jobs, events } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import { resolveTransport, type EmailConfig } from '../email/transport.js';
import { sendEmail } from '../email/send.js';
import { createMagicLink } from '../auth/magic.js';
import { retryJob } from '../jobs/queue.js';
import { newId } from '../fs/ids.js';
import type { Config } from '../config.js';

export const StudioSettings = z.object({
  studioName: z.string().min(1).default('OpenGallery'), from: z.string().default(''), timezone: z.string().min(1).default('UTC'),
  currency: z.string().length(3).regex(/^[a-z]{3}$/).default('usd'), defaultIncluded: z.number().int().min(0).default(0), defaultExtraPrice: z.number().int().min(0).default(0), reviewUrl: z.string().default(''),
});
export type StudioSettings = z.infer<typeof StudioSettings>;
export type UserRow = typeof users.$inferSelect; export type JobRow = typeof jobs.$inferSelect;

export function getStudio(db: Db): StudioSettings {
  return StudioSettings.parse({ ...(getSetting<Partial<StudioSettings>>(db, 'studio') ?? {}), studioName: getSetting<string>(db, 'studioName') ?? undefined });
}
export function setStudio(db: Db, patch: Partial<StudioSettings>, actor: string): StudioSettings {
  const next = StudioSettings.parse({ ...getStudio(db), ...patch });
  setSetting(db, 'studio', next); setSetting(db, 'studioName', next.studioName);
  db.insert(events).values({ actor, type: 'settings_changed', payload: { keys: Object.keys(patch) } }).run();
  return next;
}
export function setEmailConfig(db: Db, cfg: EmailConfig, actor: string): void {
  setSetting(db, 'email', cfg); db.insert(events).values({ actor, type: 'settings_changed', payload: { keys: ['email'] } }).run();
}
export function emailStatus(db: Db, config: Config) {
  const t = resolveTransport(db, config);
  const id = getSetting<string>(db, 'email.lastTestJob');
  const j = id ? db.select().from(jobs).where(eq(jobs.id, id)).get() : null;
  return { configured: t !== null, describe: t?.describe() ?? null, lastTest: j ? { jobId: j.id, state: j.state, lastError: j.lastError, at: j.createdAt } : null };
}
export function sendDeliveryTest(db: Db, o: { to: string; actor: string }): { jobId: string } {
  const key = `test:${o.to}:${Date.now()}`;
  sendEmail(db, { to: o.to, template: 'test_delivery', vars: { studio: getStudio(db).studioName }, key });
  const j = db.select().from(jobs).where(eq(jobs.idempotencyKey, `email:${key}`)).get()!;
  setSetting(db, 'email.lastTestJob', j.id);
  db.insert(events).values({ actor: o.actor, type: 'email_test_sent', payload: { to: o.to, jobId: j.id } }).run();
  return { jobId: j.id };
}

export class TeamError extends Error { constructor(public code: 'last_owner' | 'not_found' | 'exists' | 'self' | 'forbidden') { super(code); this.name = 'TeamError'; } }
export const listUsers = (db: Db): UserRow[] => db.select().from(users).orderBy(users.createdAt).all();
const ownerCount = (db: Db) => db.select().from(users).where(eq(users.role, 'owner')).all().length;

export function inviteUser(db: Db, o: { email: string; role: 'owner' | 'member'; actor: string; baseUrl: string; studio: string }): UserRow {
  const email = o.email.trim().toLowerCase();
  if (db.select().from(users).where(eq(users.email, email)).get()) throw new TeamError('exists');
  const id = newId();
  db.transaction((tx) => {
    const d = tx as unknown as Db;
    tx.insert(users).values({ id, email, role: o.role }).run();
    const link = createMagicLink(d, { kind: 'admin', email });
    sendEmail(d, { to: email, template: 'magic_link', vars: { studio: o.studio, url: `${o.baseUrl}/auth/${link.token}` }, key: `invite:${id}:${Date.now()}` });
    tx.insert(events).values({ actor: o.actor, type: 'user_invited', payload: { id, email, role: o.role } }).run();
  });
  return db.select().from(users).where(eq(users.id, id)).get()!;
}
export function updateUser(db: Db, o: { userId: string; patch: { role?: 'owner' | 'member'; notifyDownloads?: 'off' | 'digest' | 'each'; name?: string }; actor: string }): UserRow {
  const u = db.select().from(users).where(eq(users.id, o.userId)).get(); if (!u) throw new TeamError('not_found');
  if (o.patch.role === 'member' && u.role === 'owner' && ownerCount(db) <= 1) throw new TeamError('last_owner');
  db.update(users).set(o.patch).where(eq(users.id, o.userId)).run();
  db.insert(events).values({ actor: o.actor, type: 'user_updated', payload: { id: o.userId, keys: Object.keys(o.patch) } }).run();
  return db.select().from(users).where(eq(users.id, o.userId)).get()!;
}
export function removeUser(db: Db, o: { userId: string; actor: string }): void {
  const u = db.select().from(users).where(eq(users.id, o.userId)).get(); if (!u) throw new TeamError('not_found');
  if (u.email === o.actor.toLowerCase()) throw new TeamError('self');
  if (u.role === 'owner' && ownerCount(db) <= 1) throw new TeamError('last_owner');
  db.delete(users).where(eq(users.id, o.userId)).run();
  db.insert(events).values({ actor: o.actor, type: 'user_removed', payload: { id: o.userId, email: u.email } }).run();
}

export function listJobs(db: Db, o: { state?: JobRow['state']; limit?: number } = {}): JobRow[] {
  const q = db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(o.limit ?? 200);
  return (o.state ? q.where(eq(jobs.state, o.state)) : q.where(inArray(jobs.state, ['pending', 'running', 'failed', 'needs_review']))).all();
}
export function retryJobById(db: Db, id: string): JobRow {
  const j = db.select().from(jobs).where(eq(jobs.id, id)).get(); if (!j) throw new TeamError('not_found');
  if (j.state !== 'failed' && j.state !== 'needs_review') throw new TeamError('forbidden');
  retryJob(db, id); return db.select().from(jobs).where(eq(jobs.id, id)).get()!;
}
export { and };
```
Drop the `export { and };` and its import. Note `listJobs` default lists only non-done jobs; `?state=done` lists finished ones.

- [ ] **Step 4: Run** — green.

- [ ] **Step 5: Commit**
```bash
git add src/server/domain/settings.ts tests/domain/settings.test.ts
git commit -m "feat: studio settings, email config with delivery test, team management, jobs list and retry"
```

---

### Task 5: Dashboard

**Files:**
- Create: `src/server/domain/dashboard.ts`, `tests/domain/dashboard.test.ts`

**Interfaces:**
```ts
export type Item = { projectId: string; title: string; client: string; reason: string; count?: number; since: string }
export function dashboard(db, now = Date.now()): {
  waitingOnYou: Item[]      // culling_finished (editing with no live finals), unresolved_comments (count), drafts (count), preview_failed (count), review_jobs (count, projectId ''), issues (count, projectId '')
  waitingOnClient: Item[]   // culling_idle: production culling, last picked/viewed event older than 3 days (or never, since project entered culling)
  money: []                 // M7
  upcoming: { projectId: string; title: string; client: string; date: string }[]   // date >= today, ascending, next 10
}
```

- [ ] **Step 1: Write the failing test**

`tests/domain/dashboard.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, photos, comments, events, jobs } from '../../src/server/db/schema.js';
import { dashboard } from '../../src/server/domain/dashboard.js';
import { defaultProjectJson } from '../../src/server/fs/schemas.js';

const NOW = Date.parse('2026-06-10T12:00:00Z'); const ago = (d: number) => new Date(NOW - d * 864e5).toISOString();
function fresh() {
  const db = openDb(':memory:'); migrate(db);
  db.insert(clients).values({ id: 'c1', folderPath: 'Clients/A', name: 'Smith', emails: [] }).run();
  const mk = (id: string, title: string, production: string, date: string | null) => db.insert(projects).values({ id, clientId: 'c1', folderPath: `Clients/A/${id}`, productionState: production, date, currentRound: production === 'editing' ? 2 : 1, metadataJson: { ...defaultProjectJson(title), id: '01993840-0000-7000-8000-00000000' + id.padStart(4, '0') } }).run();
  mk('p1', 'Editing one', 'editing', null); mk('p2', 'Idle culling', 'culling', ago(-5)); mk('p3', 'Active culling', 'culling', ago(-20)); mk('p4', 'Old shoot', 'not_started', ago(3));
  return db;
}

describe('dashboard', () => {
  it('derives the four blocks', () => {
    const db = fresh();
    db.insert(photos).values([{ id: 'a', projectId: 'p1', relPath: 'raw/a.dng', stage: 'culling', kind: 'photo', checksum: 'a' }, { id: 'd', projectId: 'p1', relPath: 'finals/d.jpg', draftRelPath: 'finals/.draft/d.jpg', stage: 'final', kind: 'photo', checksum: 'd' }]).run();
    db.insert(comments).values([{ id: 'c1', photoId: 'a', author: 's', stage: 'culling', text: 'x' }, { id: 'c2', photoId: 'a', author: 's', stage: 'culling', text: 'y', resolvedAt: ago(1) }]).run();
    db.insert(events).values([
      { projectId: 'p1', actor: 's', type: 'finished_culling', payload: {}, at: ago(2) },
      { projectId: 'p2', actor: 'system', type: 'production_changed', payload: { to: 'culling' }, at: ago(10) }, { projectId: 'p2', actor: 's', type: 'picked', payload: {}, at: ago(4) },
      { projectId: 'p3', actor: 'system', type: 'production_changed', payload: { to: 'culling' }, at: ago(10) }, { projectId: 'p3', actor: 's', type: 'viewed', payload: {}, at: ago(0.5) },
      { projectId: 'p3', actor: 'system', type: 'preview_failed', payload: {}, at: ago(1) },
    ]).run();
    db.insert(jobs).values({ id: 'j1', kind: 'x', payload: {}, nextAt: 0, state: 'needs_review', lastError: 'ambiguous' }).run();
    const d = dashboard(db, NOW);
    expect(d.waitingOnYou.map((i) => [i.projectId, i.reason, i.count ?? null])).toEqual(expect.arrayContaining([
      ['p1', 'culling_finished', 3], ['p1', 'unresolved_comments', 1], ['p1', 'drafts', 1], ['p3', 'preview_failed', 1], ['', 'review_jobs', 1],
    ]));
    expect(d.waitingOnClient).toEqual([expect.objectContaining({ projectId: 'p2', reason: 'culling_idle', since: ago(4) })]);
    expect(d.upcoming.map((u) => u.projectId)).toEqual(['p2', 'p3']);
    expect(d.money).toEqual([]);
  });
});
```
(`culling_finished` count is the number of submitted picks; with no picks table rows here the count is derived from the `finished_culling` event's `photoIds` length, which is 0 — adjust the expectation to `['p1', 'culling_finished', 0]`.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

`src/server/domain/dashboard.ts`:
```ts
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, projects, photos, comments, events, jobs } from '../db/schema.js';
import { currentIssues } from '../fs/index.js';
import { ProjectJson } from '../fs/schemas.js';

export type Item = { projectId: string; title: string; client: string; reason: string; count?: number; since: string };
const IDLE_MS = 3 * 864e5;

export function dashboard(db: Db, now = Date.now()) {
  const cl = new Map(db.select().from(clients).all().map((c) => [c.id, c.name]));
  const ps = db.select().from(projects).all().filter((p) => p.available && p.archivedAt === null && p.bookingState !== 'cancelled');
  const title = (p: typeof ps[number]) => ProjectJson.parse(p.metadataJson).title;
  const ev = db.select().from(events).all();
  const last = (pid: string, types: string[]) => ev.filter((e) => e.projectId === pid && types.includes(e.type)).map((e) => e.at).sort().at(-1) ?? null;
  const waitingOnYou: Item[] = []; const waitingOnClient: Item[] = [];
  for (const p of ps) {
    const base = { projectId: p.id, title: title(p), client: cl.get(p.clientId) ?? '' };
    const rows = db.select().from(photos).where(and(eq(photos.projectId, p.id), eq(photos.missing, false))).all();
    if (p.productionState === 'editing') {
      const fin = ev.filter((e) => e.projectId === p.id && e.type === 'finished_culling').sort((a, b) => a.at.localeCompare(b.at)).at(-1);
      if (fin && !rows.some((r) => r.stage === 'final' && !r.draftRelPath)) waitingOnYou.push({ ...base, reason: 'culling_finished', count: ((fin.payload as { photoIds?: string[] }).photoIds ?? []).length, since: fin.at });
    }
    const open = db.select({ id: comments.id, at: comments.createdAt }).from(comments).innerJoin(photos, eq(photos.id, comments.photoId)).where(and(eq(photos.projectId, p.id), isNull(comments.resolvedAt))).all();
    if (open.length) waitingOnYou.push({ ...base, reason: 'unresolved_comments', count: open.length, since: open.map((c) => c.at).sort()[0]! });
    const drafts = rows.filter((r) => r.draftRelPath);
    if (drafts.length) waitingOnYou.push({ ...base, reason: 'drafts', count: drafts.length, since: last(p.id, ['uploaded', 'production_changed']) ?? new Date(now).toISOString() });
    const failed = ev.filter((e) => e.projectId === p.id && e.type === 'preview_failed');
    if (failed.length) waitingOnYou.push({ ...base, reason: 'preview_failed', count: failed.length, since: failed.map((e) => e.at).sort()[0]! });
    if (p.productionState === 'culling') {
      const seen = last(p.id, ['picked', 'unpicked', 'viewed', 'commented']) ?? last(p.id, ['production_changed']);
      if (seen && now - Date.parse(seen) > IDLE_MS) waitingOnClient.push({ ...base, reason: 'culling_idle', since: seen });
    }
  }
  const review = db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.state, ['needs_review', 'failed'])).all().length;
  if (review) waitingOnYou.push({ projectId: '', title: 'Jobs', client: '', reason: 'review_jobs', count: review, since: new Date(now).toISOString() });
  const issues = currentIssues().length;
  if (issues) waitingOnYou.push({ projectId: '', title: 'Files', client: '', reason: 'issues', count: issues, since: new Date(now).toISOString() });
  const today = new Date(now).toISOString().slice(0, 10);
  const upcoming = ps.filter((p) => p.date && p.date >= today).sort((a, b) => a.date!.localeCompare(b.date!)).slice(0, 10).map((p) => ({ projectId: p.id, title: title(p), client: cl.get(p.clientId) ?? '', date: p.date! }));
  return { waitingOnYou, waitingOnClient, money: [] as never[], upcoming };
}
```

- [ ] **Step 4: Run** — green.

- [ ] **Step 5: Commit**
```bash
git add src/server/domain/dashboard.ts tests/domain/dashboard.test.ts
git commit -m "feat: dashboard blocks derived from events, photos, jobs, and issues"
```

---

### Task 6: Admin HTTP routes

**Files:**
- Create: `src/server/http/routes/files.ts`, `src/server/http/routes/admin.ts`, `src/server/http/routes/settings.ts`, `src/server/http/routes/dashboard.ts`, `tests/http/admin.test.ts`
- Modify: `src/server/app.ts` (mount; body limit for uploads), `src/server/index.ts` (register `filesHandlers`, schedule `trash_purge` daily), `src/server/http/routes/projects.ts` (client-facing `GET /api/projects/:id/files` lists shared files only)

**Routes (all `requireKind('admin')` unless noted; owner-only marked ★):**
- `GET /api/files?path=` → `{ rel, entries }`; `POST /api/files/mkdir {path}`; `POST /api/files/move {from,to,confirm?}` (needs_confirm → 409 `{error:'needs_confirm'}`); `POST /api/files/trash {path}`; `GET /api/files/trash` → list; `POST /api/files/restore {trashRel}`; `POST /api/files/upload?path=<dir>` multipart field `file` → entry (413 on too_large, 415 unsupported, 409 exists); `GET /api/files/download?path=` → stream; `Content-Disposition: inline` only for `image/*`, `application/pdf`, `video/*`, `audio/*` by sniffed kind, otherwise `attachment`; always `X-Content-Type-Options: nosniff`, never `text/html`.
- `GET /api/clients` → `[{ id, name, emails, folderPath, projects: n }]`; `POST /api/clients {name, emails}`; `GET /api/clients/:id` → client + projects summaries; `PATCH /api/clients/:id {name?, emails?, phone?, notes?}`.
- `POST /api/projects {clientId, title, date?, included?, extraPrice?, assignedTo?}` (defaults from studio settings); `PATCH /api/projects/:id` (human patch); `POST /api/projects/:id/price {extraPrice}`; `POST /api/projects/:id/shot`; `POST /api/projects/:id/photos/order {ids}`; `POST /api/projects/:id/cover {photoId|null}`; `POST /api/projects/:id/share-file {rel, shared}`; `GET /api/projects/:id/events`; `GET /api/projects/:id/insights`; `GET /api/projects/:id/files` (admin: all non-media files in the project folder with `shared` flag; client: shared only, via `loadProject`); `POST /api/projects/:id/photos/remap {missingPhotoId, newPhotoId}`; `POST /api/issues/adopt {path}`.
- `GET /api/settings` → `{ studio, email: emailStatus, limits }`; `PATCH /api/settings/studio` ★; `PUT /api/settings/email` ★; `POST /api/settings/email/test` → `{ jobId }`; `GET /api/users`; `POST /api/users/invite` ★; `PATCH /api/users/:id` ★ (a member may PATCH only their own `notifyDownloads`); `DELETE /api/users/:id` ★; `GET /api/jobs?state=`; `POST /api/jobs/:id/retry`.
- `GET /api/dashboard`.
- Errors: `FilesError`/`AdminError`/`IdentityError`/`TeamError` → 4xx with `{ error: code }` (`not_found` 404, `exists` 409, `needs_confirm` 409, `too_large` 413, `unsupported` 415, `forbidden` 403, otherwise 422).

- [ ] **Step 1: Write the failing test**

`tests/http/admin.test.ts` — boots like `tests/http/portal.test.ts` (owner + one client + one project with a RAW and one draft final), then:
```ts
  it('files: list, mkdir, upload, download, move with confirm, trash, restore', async () => { /* listDir root shows Clients; mkdir Marketing; upload notes.txt (multipart FormData); download → 200 attachment, nosniff; upload run.sh → 415; move project cross-client → 409 needs_confirm; with confirm → 200 transfer approved; trash Marketing → 200; GET trash lists it; restore → 200; reserved path → 422 */ });
  it('clients and projects: create, patch human fields, price, shot, order, cover, shared files, events, insights, client files view', async () => { /* POST /api/clients; POST /api/projects (defaults from settings); PATCH title; PATCH allowance → 422; price; shot then shot again → 422; order; cover; share-file; client GET /api/projects/:id/files sees only shared; events length > 0; insights.views */ });
  it('identity: remap a renamed RAW and adopt a duplicate', async () => { /* rename raw on disk, index, remap via API; copy project folder, rescan, adopt via API, issues empty */ });
  it('settings: studio patch owner-only, email test job, team invite/roles, jobs list/retry', async () => { /* member cannot PATCH studio (403); owner can; email/test returns jobId and GET /api/settings shows lastTest; invite member; member PATCH own notifyDownloads ok, other user 403; owner DELETE last owner → 422; jobs list; retry a failed job */ });
  it('dashboard returns the four blocks', async () => { /* after finishing culling on the project, waitingOnYou includes culling_finished */ });
```
Write these as full tests (same helper style as `portal.test.ts`; use `new FormData()` + `new Blob([...])` for the upload body and let `app.request` set the multipart boundary).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement the four route files**

Follow the patterns in `routes/selection.ts`: zod-parse bodies, a shared `fail(c, e)` mapping domain errors to status codes, `requireKind('admin')` on every admin route, and an `ownerOnly()` middleware in `access.ts`:
```ts
export function ownerOnly(): MiddlewareHandler<AppEnv> {
  return async (c, next) => { const s = c.get('session'); const u = s && c.get('db').select().from(users).where(eq(users.email, s.subject)).get(); if (!u || u.role !== 'owner') return c.json({ error: 'forbidden' }, 403); await next(); };
}
```
Upload handler:
```ts
.post('/api/files/upload', requireKind('admin'), async (c) => {
  const dirRel = c.req.query('path') ?? ''; const body = await c.req.parseBody(); const f = body['file'];
  if (!(f instanceof File)) return c.json({ error: 'invalid body' }, 400);
  try { return c.json(await writeUpload(c.get('db'), photosDir, { dirRel, name: f.name, bytes: Buffer.from(await f.arrayBuffer()), size: f.size, actor: c.get('session')!.subject }), 201); }
  catch (e) { return fail(c, e); }
})
```
(`ponytail:` whole-file buffering; chunked uploads are deferred in the spec.) Download handler streams with `createReadStream`, sets `content-type` from the sniffed kind (`image/jpeg`, `image/png`, `application/pdf`, `video/mp4`, `audio/mpeg`, else `application/octet-stream`) and `content-disposition` per the rule above, and refuses reserved paths and `client.json`/`project.json`.

In `src/server/index.ts`: merge `filesHandlers(config.photosDir)` into `handlers`; after boot `enqueue(db, { kind: 'trash_purge', payload: {}, idempotencyKey: 'trash_purge:' + new Date().toISOString().slice(0, 10) })` and re-enqueue from the handler for the next day (same key pattern) so it runs daily.

- [ ] **Step 4: Run** — `npm run typecheck && npx vitest run tests/http` → green (M1/M2 suites included).

- [ ] **Step 5: Commit**
```bash
git add src/server/http src/server/app.ts src/server/index.ts tests/http/admin.test.ts
git commit -m "feat: admin api: files browser, clients/projects, identity resolution, settings/team/jobs, dashboard"
```

---

### Task 7: Web — admin shell, dashboard, settings

**Files:**
- Create: `src/web/admin/Shell.tsx`, `src/web/admin/Dashboard.tsx`, `src/web/admin/Settings.tsx`, `src/web/admin/api.ts` (typed helpers), `src/web/admin/ui.tsx` (Button, Field, Segmented, Pill, Empty)
- Modify: `src/web/router.ts` (+ `/admin`, `/admin/files`, `/admin/clients`, `/admin/clients/:id`, `/admin/projects/:id`, `/admin/settings`), `src/web/App.tsx` (admins land on `/admin`; `/p/:id` for admins renders the client view for preview)

**Design (HIG):** desktop ≥ 900px: left sidebar 240px with the five items (Calendar shown disabled "M6"); content pane with a large title. Phone: bottom tab bar with safe-area padding, large title that collapses on scroll (sticky header). System font, 44pt targets, light/dark from system.

- **Dashboard.tsx:** four cards in a responsive grid: Waiting on you (rows: reason label, project title · client, count badge, "since" as relative time; tap → project), Waiting on client (culling idle · Xd), Money ("Invoicing arrives with milestone 7"), Upcoming (date · title · client). Reason labels: `culling_finished` → "Picks are in", `unresolved_comments` → "Comments to answer", `drafts` → "Drafts to publish", `preview_failed` → "Previews failed", `review_jobs` → "Jobs need review" (tap → settings#jobs), `issues` → "File issues" (tap → files).
- **Settings.tsx:** one page, grouped sections with anchors: Studio (name, from, timezone, currency, default allowance, default extra price; Save; owner-only, members see read-only), Email (transport form: SMTP URL + from, or listmonk URL + token + template id; Save; "Send test email" → shows job state polling `GET /api/settings` every 2 s until done/failed with the error text), Team (list with role and notifications select; Invite by email + role; remove with confirm; last-owner and self errors surfaced), Jobs (table: kind, state, attempts, last error, created; Retry on failed/needs_review; filter state), Issues (list from `/api/issues` with the action per kind: transfer_pending → Approve; duplicate_id → "Adopt as new"; others informational), Access/Integrations/Templates/Forms/Packages/Offers/Music as disabled rows "Milestone N".

- [ ] **Step 1: Implement the shell, routes, dashboard, settings** (full code in the task; helper components in `ui.tsx`).
- [ ] **Step 2:** `npm run typecheck && npx vite build` clean. Run `npm run demo`-style manual check via the e2e harness with an owner link (add `--owner` flag to `tests/e2e/demo.ts` that prints an owner link too).
- [ ] **Step 3: Commit** `feat(web): admin shell, dashboard, settings`.

---

### Task 8: Web — Files browser and Board

**Files:**
- Create: `src/web/admin/Files.tsx`, `src/web/admin/Board.tsx`, `src/web/admin/MoveDialog.tsx`

- **Files.tsx:** breadcrumb path; toolbar: New folder, Upload (hidden `<input type=file multiple>`), List/Board segmented, search box (filters current listing by name; project/client search across the tree uses `/api/projects` + `/api/clients`); entries as rows (icon by kind/media, name, size, modified) with a "…" menu: Open (dir/project/client), Download (file), Rename (inline), Move… (folder picker dialog fetching `/api/files?path=`), Share with client (files inside a project, calls `/share-file`), Move to Trash. Project rows show the status pill and badges (unavailable, transfer pending → Approve). Drag-and-drop rows onto folder rows on desktop (HTML5 DnD) calling `/api/files/move`; on `needs_confirm` show a sheet "Move to another client? The new client's emails will gain access." with Confirm. Trash view at `.trash`: entries with Restore. Errors from the API shown in a toast.
- **Board.tsx:** columns `not_started`, `shot`, `culling`, `editing`, `delivered` with project cards (title, client, date, counters: picks, open comments, drafts); filter mine / everyone / archived; search. Drag a card from `not_started` to `shot` calls `POST /shot`; any other drag shows "This step happens automatically when RAWs land / when the client finishes / when you publish" (explains the guard).

- [ ] **Step 1: Implement.** - [ ] **Step 2:** typecheck + build + manual check (create folder, upload, move with confirm, trash, restore). - [ ] **Step 3: Commit** `feat(web): files browser with move/trash/restore and project board`.

---

### Task 9: Web — admin project detail and clients

**Files:**
- Create: `src/web/admin/Project.tsx`, `src/web/admin/Clients.tsx`

- **Project.tsx:** header: title (editable inline), client link, date, production pill, action bar by state: `not_started` → Mark shot; `culling` → Grant slots, Set allowance, Cancel round; `editing` → (Publish arrives M5, shown disabled); always under "…": Change extra price, Approve transfer (if pending), Open as client (`/p/:id`). Segments: **Photos** (stage toggle culling/finals; grid with heart state badges: confirmed red, pending amber dashed border, locked lock icon; comment counts; drafts marked "Draft"; for finals: drag to reorder + "Set as cover"; tap opens the M2 `Viewer` with an admin `onResolve` prop that calls `/api/comments/:id/resolve` and shows resolve/unresolve on the thread card; missing-photo remap: when a photo is missing and a new one exists, show "Relink to…" picker calling `/photos/remap`), **Activity** (timeline of events with actor, relative time, unresolved comments pinned first), **Insights** (views, unique visitors, a 30-day bar strip of activity by day built with plain divs, visitors list), **Details** (form of human fields: title, date, assignee select from users, download rule, comment toggles, notify on publish, expiry; machine fields read-only with the explicit actions; Files list from `/api/projects/:id/files` with the Share toggle).
- **Clients.tsx:** list with project counts and search; New client sheet (name, emails); client detail: contact fields editable, projects list with status pills, New project sheet (title, date, allowance defaults from settings).
- `Viewer.tsx` gains optional `onResolve?: (commentId: string, resolved: boolean) => Promise<void>`; when present the thread card shows a Resolve/Unresolve button.

- [ ] **Step 1: Implement.** - [ ] **Step 2:** typecheck + build + manual check. - [ ] **Step 3: Commit** `feat(web): admin project detail (photos, activity, insights, details) and clients`.

---

### Task 10: Playwright admin flow

**Files:**
- Create: `tests/e2e/admin.spec.ts`; Modify: `tests/e2e/server.ts` (expose an owner sign-in helper: request link for `owner@x.com` and return it), `tests/e2e/demo.ts` (print owner link too)

Flow (desktop viewport 1280×800, Chromium): sign in as owner → dashboard shows "Waiting on you" empty state and Upcoming empty → Clients: create "Jones" with `j@x.com` → New project "Headshots" with allowance 10 → Files: navigate to `Clients/Jones/Headshots`, New folder "Inspiration", upload a small text file, see it listed, Move to Trash, open Trash, Restore → Project detail: Details tab, change title to "Headshots 2026", Save, header updates; Photos tab of the seeded Wedding project shows 3 tiles; open one, resolve a comment posted via API → Settings: Team invite `sam@x.com` as member appears in the list; Email "Send test email" shows state `done` (memory transport) → Board: Wedding card in the `culling` column.

- [ ] Run `npm run test:e2e` → 2 passed. Commit `test: playwright admin flow`.

---

### Task 11: Milestone gate

`docs/gates/m3-admin.md` mapping: Identity (trash/restore keeps rows and ids; cross-client move confirm; duplicate adoption; remap) → `tests/domain/files.test.ts`, `tests/domain/identity.test.ts`, `tests/http/admin.test.ts`; Write policy (admin surface: reserved paths, traversal, executables, size limits, sanitised names, download disposition) → `tests/domain/files.test.ts`, `tests/http/admin.test.ts`; Minimum install (email delivery test visible state) → `tests/domain/settings.test.ts`, `tests/http/admin.test.ts`; manual desktop + phone checks of the admin shell. Commit `docs: milestone 3 gate record`, tag `m3-admin`.

## Self-review notes

- Spec §7 coverage: Files (Task 1, 6, 8), List/Board (8; production columns only until booking arrives in M6), search (8), project detail Photos/Activity/Insights/Details (3, 6, 9; Publish to client is M5 and shown disabled), Clients (3, 6, 9), Calendar (M6, disabled item), Settings groups (4, 6, 7; integrations/templates/forms/packages/offers/music/access are later milestones and shown as disabled rows), Jobs (4, 6, 7), download notifications setting (4, 7). §3 identity/trash/write policy (1, 2). §14 team (4, 6, 7). Dashboard (5, 6, 7) with Money as an honest empty state until M7.
- Types: `Entry`, `Item`, `StudioSettings` defined once server-side and mirrored in `src/web/admin/api.ts`.
