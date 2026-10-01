import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, events, clients, invoices } from '../db/schema.js';
import { ProjectMeta } from './meta.js';
import { sendEmail } from '../email/send.js';
import { studioName } from './studio.js';
import { project, summary } from './selection.js';
import { photoKey, type Storage, type PhotoVariant } from '../storage.js';
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
