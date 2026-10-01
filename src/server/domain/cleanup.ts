import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { asSystem, withStudio } from '../db/tenancy.js';
import { photos, projects } from '../db/schema.js';
import { photoKey, type PhotoVariant, type Storage } from '../storage.js';

export const CULLING_RETENTION_DAYS = 30;
const VARIANTS: PhotoVariant[] = ['original', 'preview', 'medium', 'thumb'];

/** Unpurged culling photos of projects whose latest finished_culling is older than the cutoff and that have no round open again. Scoped by RLS inside withStudio. */
function candidates(tx: Db, cutoff: string) {
  return tx.select({ id: photos.id, studioId: photos.studioId }).from(photos).innerJoin(projects, and(eq(projects.studioId, photos.studioId), eq(projects.id, photos.projectId)))
    .where(and(eq(photos.stage, 'culling'), isNull(photos.purgedAt), ne(projects.productionState, 'culling'),
      sql`(select max(e.at) from events e where e.studio_id = ${photos.studioId} and e.project_id = ${photos.projectId} and e.type = 'finished_culling') <= ${cutoff}`));
}

/**
 * Deletes the preview objects of culling photos 30 days after the Client finished picking, and sets purgedAt.
 * Rows, picks, comments and source links stay. Objects go first in the same transaction: a failed delete throws and the next run retries.
 */
export async function sweepCullingPreviews(root: Db, storage: Storage, now: Date): Promise<{ purged: number }> {
  const cutoff = new Date(now.getTime() - CULLING_RETENTION_DAYS * 864e5).toISOString();
  const studioIds = [...new Set((await asSystem(root, (tx) => candidates(tx, cutoff))).map((r) => r.studioId))];
  let purged = 0; let failure: unknown;
  for (const studioId of studioIds) {
    try {
      purged += await withStudio(root, studioId, async (tx) => {
        const rows = await candidates(tx, cutoff);
        for (const r of rows) for (const v of VARIANTS) await storage.delete(photoKey(studioId, r.id, v)); // missing keys are fine
        for (const r of rows) await tx.update(photos).set({ purgedAt: now.toISOString() }).where(eq(photos.id, r.id));
        return rows.length;
      });
    } catch (e) { console.error('[sweep] culling purge', studioId, e); failure ??= e; } // one Studio's outage must not starve the rest
  }
  if (failure) throw failure;
  return { purged };
}
