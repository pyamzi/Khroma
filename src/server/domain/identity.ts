import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { photos, picks, comments, events } from '../db/schema.js';
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
    const merged: ProjectJson = { ...fresh, ...splitFields(r.data).human, id, allowance: { included: r.data.allowance.included, extraPrice: r.data.allowance.extraPrice, slots: r.data.allowance.included } };
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
