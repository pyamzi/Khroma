import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, events, clients, invoices } from '../db/schema.js';
import { ProjectMeta } from './meta.js';
import { sendEmail } from '../email/send.js';
import { studioName } from './studio.js';
import { project, summary } from './selection.js';
import { photoKey, type Storage, type PhotoVariant } from '../storage.js';

export class DeliveryError extends Error {
  constructor(public code: 'conflict' | 'invalid' | 'not_found' | 'unavailable' | 'no_finals' | 'disabled' | 'review' | 'unpaid') { super(code); this.name = 'DeliveryError'; }
}
const PAIRS: [PhotoVariant, PhotoVariant][] = [['draft', 'original'], ['preview.draft', 'preview'], ['medium.draft', 'medium'], ['thumb.draft', 'thumb']];

/**
 * Turn drafts live for the Client and into Library photos. Copies draft → live objects first, then commits the rows, then deletes the drafts.
 * ponytail: a crash after the copies but before the commit leaves live bytes under a still-draft row; a retry copies the same draft again to the same live key, so it is idempotent.
 * Once the drafts are deleted the request transaction can still fail to commit; that rare window loses the draft, so re-upload from Lightroom.
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
    for (const p of rows) for (const v of ['draft', 'preview.draft', 'thumb.draft'] as const) if (!(await storage.exists(key(p.id, v)))) throw new DeliveryError('invalid');
    for (const p of rows) for (const [from, to] of PAIRS) {
      if (from === 'medium.draft' && !(await storage.exists(key(p.id, from)))) continue; // finals rendered before the medium size existed
      await storage.copy(key(p.id, from), key(p.id, to));
    }
    await d.update(photos).set({ live: true, draftRelPath: null, inLibrary: true }).where(inArray(photos.id, ids));
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
    for (const p of rows) for (const [from] of PAIRS) await storage.delete(key(p.id, from));
    return { published: ids.length };
  });
}
