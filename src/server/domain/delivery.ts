import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, events, clients, invoices, favorites } from '../db/schema.js';
import { ProjectMeta } from './meta.js';
import { sendEmail } from '../email/send.js';
import { studioName } from './studio.js';
import { project, summary } from './selection.js';
import { previewVersion } from './photos.js';
import { photoKey, zipKey, type Storage, type PhotoVariant } from '../storage.js';
import { enqueue, type Handlers } from '../jobs/queue.js';

export class DeliveryError extends Error {
  constructor(public code: 'conflict' | 'invalid' | 'not_found' | 'unavailable' | 'no_finals' | 'disabled' | 'review' | 'unpaid') { super(code); this.name = 'DeliveryError'; }
}
// original last: a photo that fails midway never has a new original under old previews
const PAIRS: [PhotoVariant, PhotoVariant][] = [['preview.draft', 'preview'], ['medium.draft', 'medium'], ['thumb.draft', 'thumb'], ['draft', 'original']];
const DRAFTS: PhotoVariant[] = ['draft', 'preview.draft', 'medium.draft', 'thumb.draft'];

/** Run `fn` over `items` with at most `n` in flight; after the first failure no new item starts and it rejects. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0; let failed = false;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (!failed && i < items.length) { try { await fn(items[i++]!); } catch (e) { failed = true; throw e; } }
  }));
}

/**
 * Light job handler: deletes the given objects, missing ones included, so a retry is safe.
 * A replacement uploaded after the publish reuses the same draft keys, so draft objects of a photo that has a draft again are left alone.
 * ponytail: a retried job can still delete a live `medium` that a later publish just copied; the job only retries after an R2 failure, so the window is narrow. Close it by versioning keys if it ever bites.
 */
export function makeDeliveryHandlers(storage: Storage): Handlers {
  return {
    delete_objects: async (payload, { db }) => {
      const keys = (payload as { keys: string[] }).keys; const photoOf = (k: string) => k.split('/')[3]!;
      const redrafted = new Set((await db.select({ id: photos.id }).from(photos).where(and(inArray(photos.id, [...new Set(keys.map(photoOf))]), isNotNull(photos.draftRelPath)))).map((r) => r.id));
      await pool(keys.filter((k) => !(redrafted.has(photoOf(k)) && k.endsWith('draft'))), 8, (k) => storage.delete(k));
    },
  };
}

/**
 * Turn drafts live for the Client and into Library photos. Copies draft → live objects first, then commits the rows; the drafts (and a stale live medium)
 * are deleted by a `delete_objects` job queued in the same transaction, so nothing is deleted unless the publish commits.
 * ponytail: a crash after the copies but before the commit leaves live bytes under a still-draft row; a retry copies the same draft again to the same live key, so it is idempotent.
 * Copies run per photo with `original` last, but a batch that fails midway can leave earlier photos showing replacement previews until the retry.
 */
export function publishFinals(db: Db, storage: Storage, o: { projectId: string; photoIds: string[]; expectedVersion: number; actor: string; baseUrl: string }): Promise<{ published: number }> {
  return db.transaction(async (d) => {
    const r = await project(d, o.projectId, true).catch(() => { throw new DeliveryError('not_found'); });
    if (r.stateVersion !== o.expectedVersion) throw new DeliveryError('conflict');
    if (r.archivedAt !== null || r.bookingState === 'cancelled' || !['editing', 'delivered'].includes(r.productionState)) throw new DeliveryError('invalid');
    const s = await summary(d, o.projectId);
    if (s.deficit > 0 || s.pending > 0) throw new DeliveryError('invalid');
    if ((await d.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.projectId, o.projectId), eq(invoices.needsReview, true))).limit(1)).length) throw new DeliveryError('invalid');
    const ids = [...new Set(o.photoIds)];
    const rows = ids.length ? await d.select().from(photos).where(and(eq(photos.projectId, o.projectId), eq(photos.stage, 'final'), inArray(photos.id, ids))) : [];
    if (!ids.length || rows.length !== ids.length || rows.some((p) => !p.draftRelPath)) throw new DeliveryError('invalid');
    const key = (id: string, v: PhotoVariant) => photoKey(r.studioId, id, v);
    // a draft whose previews have not rendered yet would go live without them
    // validate every draft before copying any: a rejected batch must leave every live object untouched
    await pool(rows, 8, async (p) => { for (const v of ['draft', 'preview.draft', 'thumb.draft'] as const) if (!(await storage.exists(key(p.id, v)))) throw new DeliveryError('invalid'); });
    const stale: string[] = []; // live objects with no draft counterpart
    await pool(rows, 8, async (p) => {
      for (const [from, to] of PAIRS) {
        if (from === 'medium.draft' && !(await storage.exists(key(p.id, from)))) { stale.push(key(p.id, to)); continue; } // finals rendered before the medium size existed: drop the old medium so the route falls back to the new preview
        await storage.copy(key(p.id, from), key(p.id, to));
      }
    });
    await d.update(photos).set({ live: true, draftRelPath: null, inLibrary: true, readyAt: new Date().toISOString() }).where(inArray(photos.id, ids)); // readyAt moves the preview version `v`
    const sources = rows.map((p) => p.sourcePhotoId).filter((x): x is string => !!x);
    if (sources.length) await d.update(photos).set({ editState: 'done' }).where(and(eq(photos.projectId, o.projectId), inArray(photos.id, sources)));
    const version = r.stateVersion + 1;
    await d.update(projects).set({ productionState: 'delivered', stateVersion: version }).where(eq(projects.id, o.projectId));
    if (r.productionState !== 'delivered') await d.insert(events).values({ projectId: o.projectId, actor: 'system', type: 'production_changed', payload: { from: r.productionState, to: 'delivered' } });
    await d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'finals_published', payload: { photoIds: ids } });
    const meta = ProjectMeta.parse(r.metadataJson);
    if (meta.notifyOnPublish) {
      const [cl] = await d.select({ emails: clients.emails }).from(clients).where(eq(clients.id, r.clientId)).limit(1);
      const studio = await studioName(d);
      for (const to of cl?.emails ?? [])
        await sendEmail(d, { to, template: 'gallery_ready', vars: { studio, project: meta.title, url: `${o.baseUrl}/p/${o.projectId}/gallery` }, key: `gallery:${o.projectId}:${version}:${to}` });
    }
    await enqueue(d, { kind: 'delete_objects', payload: { keys: [...rows.flatMap((p) => DRAFTS.map((v) => key(p.id, v))), ...stale] }, idempotencyKey: `publish-drafts:${o.projectId}:${version}` });
    return { published: ids.length };
  });
}

type Reason = 'unavailable' | 'no_finals' | 'disabled' | 'review' | 'unpaid';
const liveFinals = (db: Db, projectId: string) => db.select({ id: photos.id, relPath: photos.relPath, checksum: photos.checksum, readyAt: photos.readyAt }).from(photos)
  .where(and(eq(photos.projectId, projectId), eq(photos.stage, 'final'), eq(photos.live, true))).orderBy(photos.relPath);

/** Whether the Client may download, and the first reason why not. Zero invoices count as settled. */
export async function downloadStatus(db: Db, projectId: string): Promise<{ allowed: boolean; reason: Reason | null }> {
  const p = await project(db, projectId); const no = (reason: Reason) => ({ allowed: false, reason });
  if (p.archivedAt !== null || p.bookingState === 'cancelled') return no('unavailable');
  if (!(await liveFinals(db, projectId).limit(1)).length) return no('no_finals');
  if (ProjectMeta.parse(p.metadataJson).downloads === 'none') return no('disabled'); // 'password' counts as 'client' until H2b
  const inv = await db.select().from(invoices).where(eq(invoices.projectId, projectId));
  if (inv.some((i) => i.needsReview) || (await summary(db, projectId)).deficit > 0) return no('review');
  if (inv.some((i) => i.voidedAt === null && i.paidAmount - i.refundedAmount < i.amount + i.tax)) return no('unpaid');
  return { allowed: true, reason: null };
}

/** sha256 of the sorted `id:checksum` lines. */
export const liveSetHash = (rows: { id: string; checksum: string }[]) => createHash('sha256').update(rows.map((r) => `${r.id}:${r.checksum}`).sort().join('\n')).digest('hex');
// The row's checksum lands at a replacement's upload, before its bytes go live; previewVersion also moves at publish, so a ZIP is keyed by the bytes it holds.
const setHash = (rows: { id: string; checksum: string; readyAt: string | null }[]) => liveSetHash(rows.map((r) => ({ id: r.id, checksum: previewVersion(r) })));

/** Names given to browsers and ZIP entries carry no control characters. */
export const cleanName = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '');
/** One entry name per path: its basename, with ` (2)`, ` (3)` … for names already taken (case-insensitively, as Files and Windows see them). */
export function zipEntryNames(relPaths: string[]): string[] {
  const taken = new Set<string>();
  return relPaths.map((rp) => {
    const name = cleanName(basename(rp)); const ext = extname(name); const stem = name.slice(0, name.length - ext.length);
    let out = name; for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${stem} (${n})${ext}`;
    taken.add(out.toLowerCase()); return out;
  });
}

/**
 * A 10-minute R2 URL for one live final or a ZIP of all of them. A missing ZIP is queued for the worker and the caller polls.
 * ponytail: the job's idempotency key outlives the ZIP; if an R2 lifecycle rule ever expires ZIPs, a done job for the same set must be re-queued here.
 */
export async function requestDownload(db: Db, storage: Storage, o: { projectId: string; photoId?: string; actor: string }): Promise<{ url: string } | { preparing: true }> {
  const p = await project(db, o.projectId).catch(() => { throw new DeliveryError('not_found'); });
  const rows = await liveFinals(db, p.id);
  const one = o.photoId === undefined ? null : rows.find((r) => r.id === o.photoId);
  if (one === undefined) throw new DeliveryError('not_found'); // before the entitlement check: a guessed id learns nothing
  const st = await downloadStatus(db, p.id); if (!st.allowed) throw new DeliveryError(st.reason!);
  let key: string; let name: string;
  if (one) { key = photoKey(p.studioId, one.id, 'original'); name = cleanName(basename(one.relPath)); }
  else {
    const hash = setHash(rows); key = zipKey(p.studioId, p.id, hash);
    if (!(await storage.exists(key))) {
      await enqueue(db, { kind: 'build_zip', payload: { projectId: p.id, hash }, idempotencyKey: `zip:${p.id}:${hash}` });
      return { preparing: true };
    }
    name = `${cleanName(ProjectMeta.parse(p.metadataJson).title).replace(/[/\\]/g, '').trim() || 'gallery'}.zip`;
  }
  await db.insert(events).values({ projectId: p.id, actor: o.actor, type: 'downloaded', payload: { item: one?.id ?? 'all' } });
  return { url: await storage.presignGet(key, 600, name) };
}

const run = promisify(execFile);
/**
 * Heavy job: a stored (uncompressed) ZIP of the live finals at `zipKey`. A set that changed since the request ends quietly; the new set has its own job.
 * ponytail: the finished ZIP is read into memory for `put`; switch to a multipart upload if galleries outgrow the worker's RAM.
 */
export function makeZipHandlers(storage: Storage): Handlers {
  return {
    build_zip: async (payload, { db, studioId }) => {
      const { projectId, hash } = payload as { projectId: string; hash: string };
      const rows = await liveFinals(db, projectId);
      const key = zipKey(studioId, projectId, hash);
      if (setHash(rows) !== hash || (await storage.exists(key))) return;
      const dir = await mkdtemp(join(tmpdir(), 'og-zip-')); const files = join(dir, 'files');
      try {
        await mkdir(files); const names = zipEntryNames(rows.map((r) => r.relPath));
        await pool(rows.map((r, i) => ({ id: r.id, name: names[i]! })), 4, async ({ id, name }) => {
          const obj = await storage.get(photoKey(studioId, id, 'original'));
          if (!obj) throw new Error(`build_zip: no original for ${id}`);
          await pipeline(Readable.fromWeb(obj.body as NodeReadableStream<Uint8Array>), createWriteStream(join(files, name)));
        });
        // `-r .` from inside the folder: entry names are never read as options
        await run('zip', ['-q', '-0', '-X', '-r', join(dir, 'out.zip'), '.'], { cwd: files, timeout: 10 * 60_000, killSignal: 'SIGKILL' });
        await storage.put(key, await readFile(join(dir, 'out.zip')), 'application/zip');
      } finally { await rm(dir, { recursive: true, force: true }); }
    },
  };
}

/** Hearts belong to a person, not a sign-in: `<kind>:<lowercased subject>`. */
export const viewerKey = (v: { kind: string; subject: string }) => `${v.kind}:${v.subject.toLowerCase()}`;
/** Heart counts over the project's live finals, and the ones `key` hearted. */
export async function favoritesOf(db: Db, projectId: string, key: string): Promise<{ counts: Record<string, number>; mine: string[] }> {
  const rows = await db.select({ photoId: favorites.photoId, viewerKey: favorites.viewerKey }).from(favorites).innerJoin(photos, eq(photos.id, favorites.photoId))
    .where(and(eq(photos.projectId, projectId), eq(photos.stage, 'final'), eq(photos.live, true)));
  const counts: Record<string, number> = {}; for (const r of rows) counts[r.photoId] = (counts[r.photoId] ?? 0) + 1;
  return { counts, mine: rows.filter((r) => r.viewerKey === key).map((r) => r.photoId) };
}
/** Idempotent either way. The caller checks the photo is a live final the viewer can see. */
export async function setFavorite(db: Db, o: { photoId: string; viewerKey: string; favorite: boolean }): Promise<void> {
  if (o.favorite) await db.insert(favorites).values({ photoId: o.photoId, viewerKey: o.viewerKey }).onConflictDoNothing();
  else await db.delete(favorites).where(and(eq(favorites.photoId, o.photoId), eq(favorites.viewerKey, o.viewerKey)));
}
