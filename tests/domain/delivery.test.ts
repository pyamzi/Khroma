import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { clients, photos, projects, events, jobs, invoices } from '../../src/server/db/schema.js';
import { memoryStorage, photoKey, type Storage } from '../../src/server/storage.js';
import { defaultProjectMeta } from '../../src/server/domain/meta.js';
import { addPhoto } from '../../src/server/domain/photos.js';
import { setPick } from '../../src/server/domain/selection.js';
import { uploadFinal } from '../../src/server/domain/finals.js';
import { publishFinals, DeliveryError, makeDeliveryHandlers } from '../../src/server/domain/delivery.js';
import { tiffBytes } from '../fixtures/make.js';
import type { Db } from '../../src/server/db/client.js';
import type { Handler } from '../../src/server/jobs/queue.js';
import { studioTestDb } from '../helpers.js';

const jpeg = (bg = '#c33') => sharp({ create: { width: 40, height: 30, channels: 3, background: bg } }).jpeg().toBuffer();
const pid = 'p1';
const BASE = 'http://localhost:3000';

// ponytail: finals are put into `editing` directly (not through a finished culling round), except where pending picks matter
async function seed(o: { emails?: string[]; notify?: boolean; included?: number } = {}) {
  const s = await studioTestDb(); const { db } = s; const storage = memoryStorage();
  const m = defaultProjectMeta('Wedding'); m.allowance = { included: o.included ?? 5, extraPrice: 0 }; m.notifyOnPublish = o.notify ?? false;
  await db.insert(clients).values({ id: 'c1', name: 'Smith', emails: o.emails ?? ['s@x.com'] });
  await db.insert(projects).values({ id: pid, clientId: 'c1', productionState: 'editing', metadataJson: m as Record<string, unknown> });
  const src = (await addPhoto(db, storage, { projectId: pid, relPath: 'raw/a.dng', stage: 'culling', bytes: await tiffBytes(), name: 'a.dng' })).photoId;
  const src2 = (await addPhoto(db, storage, { projectId: pid, relPath: 'raw/b.dng', stage: 'culling', bytes: await tiffBytes(), name: 'b.dng' })).photoId;
  /** A draft with its rendered previews, as the preview job leaves it. */
  const draft = async (name: string, source: string, bg = '#c33', medium = true) => {
    const r = await uploadFinal(db, storage, { projectId: pid, name, bytes: await jpeg(bg), sourcePhotoId: source, uploadId: `u-${name}-${bg}`, actor: 'plugin' });
    for (const v of ['preview.draft', 'thumb.draft'] as const) await storage.put(photoKey(s.studioId, r.photoId, v), new TextEncoder().encode(`${v}:${bg}`), 'image/jpeg');
    if (medium) await storage.put(photoKey(s.studioId, r.photoId, 'medium.draft'), new TextEncoder().encode(`medium.draft:${bg}`), 'image/jpeg');
    return r.photoId;
  };
  const proj = async () => (await db.select().from(projects).where(eq(projects.id, pid)))[0]!;
  const pub = async (ids: string[], v?: number, st: Storage = storage) => publishFinals(db, st, { projectId: pid, photoIds: ids, expectedVersion: v ?? (await proj()).stateVersion, actor: 'owner@x', baseUrl: BASE });
  const text = async (id: string, v: Parameters<typeof photoKey>[2]) => { const b = await storage.getBytes(photoKey(s.studioId, id, v)); return b && new TextDecoder().decode(b); };
  return { ...s, storage, src, src2, draft, proj, pub, text };
}
const runDeleteJob = async (db: Db, storage: Storage) => {
  for (const j of (await db.select().from(jobs)).filter((x) => x.kind === 'delete_objects')) await (makeDeliveryHandlers(storage).delete_objects as Handler)(j.payload, { db, jobId: j.id, studioId: j.studioId });
};
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof DeliveryError ? e.code : String(e)));

describe('publishFinals', () => {
  it('goes live: swaps the draft into the live objects, deletes the drafts, marks Library, source done, project delivered', async () => {
    const { db, storage, studioId, src, src2, draft, pub, proj, text } = await seed();
    const f = await draft('A.jpg', src);
    const before = (await proj()).stateVersion;
    expect(await pub([f])).toEqual({ published: 1 });
    const [row] = await db.select().from(photos).where(eq(photos.id, f));
    expect(row).toMatchObject({ live: true, draftRelPath: null, inLibrary: true });
    expect(await text(f, 'preview')).toBe('preview.draft:#c33'); expect(await text(f, 'thumb')).toBe('thumb.draft:#c33'); expect(await text(f, 'medium')).toBe('medium.draft:#c33');
    expect((await sharp((await storage.getBytes(photoKey(studioId, f, 'original')))!).metadata()).width).toBe(40);
    for (const v of ['draft', 'preview.draft', 'medium.draft', 'thumb.draft'] as const) expect(await storage.exists(photoKey(studioId, f, v))).toBe(true); // deleted by the job, after the commit
    const done = async (id: string) => (await db.select().from(photos).where(eq(photos.id, id)))[0]!.editState;
    expect(await done(src)).toBe('done'); expect(await done(src2)).toBe('none'); // only sources with a live final
    expect(await proj()).toMatchObject({ productionState: 'delivered', stateVersion: before + 1 });
    const ev = (await db.select().from(events).where(eq(events.type, 'finals_published')))[0]!; expect(ev.payload).toEqual({ photoIds: [f] });
  });

  it('a replacement keeps the photo id and swaps the live bytes; with no medium.draft the stale live medium is dropped', async () => {
    const { db, storage, studioId, src, draft, pub, text } = await seed();
    const f = await draft('A.jpg', src, '#c33'); await pub([f]); await runDeleteJob(db, storage); // publish 1's drafts go before the replacement arrives
    const f2 = await draft('A.jpg', src, '#33c', false); expect(f2).toBe(f);
    await storage.put(photoKey(studioId, f, 'medium'), new TextEncoder().encode('old-medium'), 'image/jpeg');
    await pub([f]);
    expect(await text(f, 'preview')).toBe('preview.draft:#33c');
    await runDeleteJob(db, storage); expect(await text(f, 'medium')).toBeNull(); // the route then falls back to the new preview
  });

  it('drafts are deleted by a job after commit; a failing delete leaves the publish done and the job pending; the handler is idempotent', async () => {
    const { db, storage, studioId, src, draft, pub, proj } = await seed();
    const f = await draft('A.jpg', src); await pub([f]);
    const [job] = (await db.select().from(jobs)).filter((j) => j.kind === 'delete_objects'); expect(job!.idempotencyKey).toBe(`publish-drafts:${pid}:${(await proj()).stateVersion}`);
    expect((job!.payload as { keys: string[] }).keys.sort()).toEqual(['draft', 'medium.draft', 'preview.draft', 'thumb.draft'].map((v) => photoKey(studioId, f, v as 'draft')).sort());
    const failing = { ...storage, delete: async () => { throw new Error('r2 down'); } } as Storage;
    await expect(makeDeliveryHandlers(failing).delete_objects!(job!.payload, { db, jobId: job!.id, studioId } as never)).rejects.toThrow('r2 down');
    expect((await proj()).productionState).toBe('delivered'); expect(await storage.exists(photoKey(studioId, f, 'draft'))).toBe(true);
    await runDeleteJob(db, storage); await runDeleteJob(db, storage); // twice: missing keys are ignored
    for (const v of ['draft', 'preview.draft', 'medium.draft', 'thumb.draft'] as const) expect(await storage.exists(photoKey(studioId, f, v))).toBe(false);
    expect(await storage.exists(photoKey(studioId, f, 'preview'))).toBe(true);
  });

  it('a stale expectedVersion is a conflict and changes nothing', async () => {
    const { db, src, draft, pub, proj } = await seed();
    const f = await draft('A.jpg', src); const v = (await proj()).stateVersion;
    expect(await code(pub([f], v - 1))).toBe('conflict');
    expect((await db.select().from(photos).where(eq(photos.id, f)))[0]).toMatchObject({ live: false, inLibrary: false });
    expect((await proj()).productionState).toBe('editing');
  });

  it('refuses: unknown or non-draft photos, wrong state, archived, needs-review invoice, empty list', async () => {
    const { db, src, draft, pub } = await seed();
    const f = await draft('A.jpg', src);
    expect(await code(pub([]))).toBe('invalid'); expect(await code(pub(['nope']))).toBe('invalid'); expect(await code(pub([src]))).toBe('invalid'); // a RAW is not a final
    await db.insert(invoices).values({ id: 'i1', projectId: pid, kind: 'extras', amount: 1, currency: 'USD', needsReview: true });
    expect(await code(pub([f]))).toBe('invalid');
    await db.delete(invoices).where(eq(invoices.id, 'i1'));
    await db.update(projects).set({ productionState: 'culling' }).where(eq(projects.id, pid)); expect(await code(pub([f]))).toBe('invalid');
    await db.update(projects).set({ productionState: 'editing', archivedAt: new Date().toISOString() }).where(eq(projects.id, pid)); expect(await code(pub([f]))).toBe('invalid');
    await db.update(projects).set({ archivedAt: null, bookingState: 'cancelled' }).where(eq(projects.id, pid)); expect(await code(pub([f]))).toBe('invalid');
    await db.update(projects).set({ bookingState: 'inquiry' }).where(eq(projects.id, pid)); expect(await code(pub([f]))).toBe('ok');
  });

  it('pending picks or a deficit refuse publishing', async () => {
    const { db, src, draft, pub, proj } = await seed({ included: 0 });
    const f = await draft('A.jpg', src);
    await db.update(projects).set({ productionState: 'culling' }).where(eq(projects.id, pid));
    await setPick(db, { projectId: pid, photoId: src, picked: true, byEmail: 's@x.com', expectedVersion: (await proj()).selectionVersion }); // included 0 → pending
    await db.update(projects).set({ productionState: 'editing' }).where(eq(projects.id, pid));
    expect(await code(pub([f]))).toBe('invalid');
    expect((await db.select().from(photos).where(eq(photos.id, f)))[0]!.live).toBe(false);
  });

  it('refuses a draft whose previews are not rendered yet', async () => {
    const { db, src, draft, pub, storage, studioId } = await seed();
    const f = await draft('A.jpg', src); await storage.delete(photoKey(studioId, f, 'thumb.draft'));
    expect(await code(pub([f]))).toBe('invalid');
    expect((await db.select().from(photos).where(eq(photos.id, f)))[0]!.live).toBe(false);
  });

  it('notifyOnPublish queues one gallery_ready email per Client address; off by default', async () => {
    const off = await seed(); const f0 = await off.draft('A.jpg', off.src); await off.pub([f0]);
    expect((await off.db.select().from(jobs)).filter((j) => j.kind === 'send_email')).toHaveLength(0);
    const on = await seed({ notify: true, emails: ['a@x.com', 'b@x.com'] }); const f = await on.draft('A.jpg', on.src);
    const v = (await on.proj()).stateVersion; await on.pub([f]);
    const mails = (await on.db.select().from(jobs)).filter((j) => j.kind === 'send_email').map((j) => j.payload as { to: string; template: string; key: string; vars: Record<string, string> });
    expect(mails.map((m) => m.to).sort()).toEqual(['a@x.com', 'b@x.com']);
    expect(mails[0]).toMatchObject({ template: 'gallery_ready', vars: { project: 'Wedding', url: `${BASE}/p/${pid}/gallery` } });
    expect(mails.map((m) => m.key).sort()).toEqual([`gallery:${pid}:${v + 1}:a@x.com`, `gallery:${pid}:${v + 1}:b@x.com`]);
  });
});
