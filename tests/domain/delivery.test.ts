import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { clients, photos, projects, events, jobs, invoices, picks } from '../../src/server/db/schema.js';
import { memoryStorage, photoKey, type Storage } from '../../src/server/storage.js';
import { defaultProjectMeta } from '../../src/server/domain/meta.js';
import { addPhoto } from '../../src/server/domain/photos.js';
import { setPick } from '../../src/server/domain/selection.js';
import { uploadFinal } from '../../src/server/domain/finals.js';
import { publishFinals, DeliveryError, makeDeliveryHandlers, makeZipHandlers, downloadStatus, liveSetHash, requestDownload, zipEntryNames, cleanName } from '../../src/server/domain/delivery.js';
import { tiffBytes } from '../fixtures/make.js';
import type { Db } from '../../src/server/db/client.js';
import { NeedsReview, type Handler } from '../../src/server/jobs/queue.js';
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
const setMeta = async (db: Db, patch: Record<string, unknown>) => {
  const [p] = await db.select().from(projects).where(eq(projects.id, pid));
  await db.update(projects).set({ metadataJson: { ...p!.metadataJson, ...patch } }).where(eq(projects.id, pid));
};
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

  it('a batch with a live replacement and an unrendered draft is invalid and leaves the replacement\'s live objects untouched', async () => {
    const { storage, studioId, src, src2, draft, pub, text } = await seed();
    const a = await draft('A.jpg', src, '#c33'); await pub([a]);
    const liveOriginal = await storage.getBytes(photoKey(studioId, a, 'original')); const livePreview = await text(a, 'preview');
    await draft('A.jpg', src, '#33c'); // replacement of the live A, fully rendered
    const b = await draft('B.jpg', src2, '#3c3'); await storage.delete(photoKey(studioId, b, 'preview.draft')); // B's render has not finished
    expect(await code(pub([a, b]))).toBe('invalid');
    expect(await storage.getBytes(photoKey(studioId, a, 'original'))).toEqual(liveOriginal); expect(await text(a, 'preview')).toBe(livePreview);
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

describe('downloads', () => {
  it('downloadStatus reasons in order', async () => {
    const { db, src, draft, pub } = await seed();
    const st = async () => (await downloadStatus(db, pid)).reason;
    await db.update(projects).set({ archivedAt: new Date().toISOString() }).where(eq(projects.id, pid));
    expect(await st()).toBe('unavailable'); // before no_finals
    await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, pid));
    expect(await st()).toBe('no_finals');
    await pub([await draft('A.jpg', src)]);
    expect(await downloadStatus(db, pid)).toEqual({ allowed: true, reason: null }); // zero invoices: settled
    await db.insert(invoices).values({ id: 'i1', projectId: pid, kind: 'balance', amount: 100, tax: 10, paidAmount: 100, currency: 'USD', needsReview: true });
    await setMeta(db, { downloads: 'none' });
    expect(await st()).toBe('disabled');
    await setMeta(db, { downloads: 'password' }); // treated as 'client' until H2b
    expect(await st()).toBe('review');
    await db.update(invoices).set({ needsReview: false }).where(eq(invoices.id, 'i1'));
    expect(await st()).toBe('unpaid'); // 100 paid of 110
    await db.update(invoices).set({ paidAmount: 110 }).where(eq(invoices.id, 'i1'));
    expect(await st()).toBeNull();
    await db.update(invoices).set({ refundedAmount: 5 }).where(eq(invoices.id, 'i1'));
    expect(await st()).toBe('unpaid');
    await db.update(invoices).set({ voidedAt: new Date().toISOString() }).where(eq(invoices.id, 'i1'));
    expect(await st()).toBeNull(); // a voided invoice is not owed
    await db.update(projects).set({ currentRound: 2 }).where(eq(projects.id, pid)); await setMeta(db, { allowance: { included: 0, extraPrice: 0 } });
    await db.insert(picks).values({ projectId: pid, photoId: src, round: 1, byEmail: 's@x.com', state: 'confirmed' }); // one submitted pick, entitlement 0
    expect(await st()).toBe('review');
    await db.update(projects).set({ bookingState: 'cancelled' }).where(eq(projects.id, pid));
    expect(await st()).toBe('unavailable');
  });

  it('liveSetHash ignores order and changes with any id or checksum', () => {
    const a = { id: 'a', checksum: '1' }, b = { id: 'b', checksum: '2' };
    expect(liveSetHash([a, b])).toBe(liveSetHash([b, a])); expect(liveSetHash([a, b])).toMatch(/^[0-9a-f]{64}$/);
    expect(liveSetHash([a, { ...b, checksum: '3' }])).not.toBe(liveSetHash([a, b])); expect(liveSetHash([a])).not.toBe(liveSetHash([a, b]));
  });

  it('single download returns a 10-minute signed URL for the live original only', async () => {
    const { db, storage, studioId, src, src2, draft, pub } = await seed();
    const f = await draft('A.jpg', src); await pub([f]); const d = await draft('B.jpg', src2); // d stays a draft
    const calls: unknown[][] = [];
    const spy: Storage = { ...storage, presignGet: async (k, ttl, name) => { calls.push([k, ttl, name]); return storage.presignGet(k, ttl, name); } };
    const r = await requestDownload(db, spy, { projectId: pid, photoId: f, actor: 's@x.com' });
    expect(r).toEqual({ url: expect.stringContaining(photoKey(studioId, f, 'original')) });
    expect(calls).toEqual([[photoKey(studioId, f, 'original'), 600, 'A.jpg']]);
    for (const id of [d, src, 'nope']) expect(await code(requestDownload(db, spy, { projectId: pid, photoId: id, actor: 's@x.com' }))).toBe('not_found');
    const ev = (await db.select().from(events).where(eq(events.type, 'downloaded'))); expect(ev.map((e) => [e.actor, e.payload])).toEqual([['s@x.com', { item: f }]]);
    await setMeta(db, { downloads: 'none' });
    expect(await code(requestDownload(db, spy, { projectId: pid, photoId: f, actor: 's@x.com' }))).toBe('disabled');
  });

  it('build_zip sums every original before the 3 GiB cap: three 2 GiB photos go to review and nothing is downloaded', async () => {
    const { db, storage, studioId, src, src2, draft, pub } = await seed();
    await pub([await draft('A.jpg', src), await draft('B.jpg', src2), await draft('C.jpg', src)]);
    expect(await requestDownload(db, storage, { projectId: pid, actor: 's@x.com' })).toEqual({ preparing: true });
    const [job] = (await db.select().from(jobs)).filter((j) => j.kind === 'build_zip');
    let gets = 0;
    const big: Storage = { ...storage, size: async () => 2 * 1024 ** 3, get: async (k) => { gets++; return storage.get(k); } };
    const err = await (makeZipHandlers(big).build_zip as Handler)(job!.payload, { db, jobId: job!.id, studioId }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsReview); expect((err as Error).message).toBe('too_large');
    expect(gets).toBe(0);
  });

  it('download names: control characters stripped, ZIP entries unique case-insensitively', () => {
    expect(cleanName('A\x07b\x7f.jpg')).toBe('Ab.jpg');
    expect(zipEntryNames(['finals/A.jpg', 'other/A.jpg', 'x/a.jpg', 'f/b\x01.jpg', 'f/A (2).jpg'])).toEqual(['A.jpg', 'A (2).jpg', 'a (3).jpg', 'b.jpg', 'A (2) (2).jpg']);
  });
});
