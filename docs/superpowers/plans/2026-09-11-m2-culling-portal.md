# OpenGallery Milestone 2: Client Culling Portal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client can sign in, open their project, cull RAW previews in a three-across grid with a shared selection across every client email, see how many picks they have left, request extras (local mode: no payment), draw region comments on photos, and finish the round; the studio is emailed and the project moves to `editing`.

**Architecture:** Two new domain modules over the M1 foundation: `selection` (entitlement, pick/unpick with optimistic concurrency, recompute confirmed/pending, grants) and `transitions` (guarded production-state moves: ingest → `culling`, finish → `editing`). Routes are thin wrappers that call the domain and return the same summary the UI renders. The React shell grows a tiny path router, a project home, the culling grid, and a full-screen viewer with comment pins. A Playwright test drives the built UI on an iPhone viewport against an in-process server with the memory mail transport.

**Tech Stack:** Everything from M1 (Node 24 pinned, Hono, Drizzle + better-sqlite3, React + Tailwind, Vitest) plus `playwright` (dev) for one end-to-end flow.

**Spec:** `docs/superpowers/specs/2026-09-10-opengallery-design.md` Revision 2, sections 4 (picks, slot_grants, comments, derived entitlement), 6 (client portal), 10 (transitions: first RAW → culling, finish → editing), 17, 18 (gates *Rounds*, *Extras* without payment, *Workflow* culling cases). Section 21 milestone 2: "sign-in, culling grid, viewer, shared selection with slots, finish under allowance, comments, project home. Local mode only (no Stripe yet). Gates: rounds, extras math without payment."

## Global Constraints

- All M1 global constraints apply (Node 24 via `.node-version`, strict TS, ESM, WAL + foreign keys, commit-then-call, hashed single-use links, no seeded accounts).
- **Entitlement is derived, never stored:** `included` (from `project.json.allowance`, machine-owned) + Σ `slot_grants.delta`. `allowance.slots` in the file is a projection of that sum.
- **One shared selection per project:** `picks` is unique on (project_id, photo_id). A photo counts once regardless of which client email picked it.
- **Recompute after every change** in one transaction: submitted-round picks first (always confirmed, never touched), then current-round picks ordered by `picked_at`, then `photo_id`; the first `entitlement − submitted` become `confirmed`, the rest `pending`.
- **Optimistic concurrency:** pick, unpick, and finish carry `selectionVersion`; a stale value returns HTTP 409 `{ error: 'conflict', selectionVersion }` and the client refreshes. `stateVersion` continues to cover workflow state and is projected to `project.json`; `selectionVersion` is database-only. (Deliberate refinement of spec §6, which names `stateVersion`; recorded in the gate record.)
- **Finish guards:** production `culling`; at least one current-round pick; zero pending picks; no unpaid `extras` invoice; no invoice with `needs_review`; no slot deficit. Allowance is a maximum, never a quota.
- **Comments:** plain text, 1–2000 chars; region `x,y,w,h` in 0–1 with `w,h > 0`, or `t ≥ 0` seconds for videos; never both. Clients may comment only when `project.comments[stage]` is on; admins always may.
- **Local mode:** no Stripe. Above entitlement the bar reads "Request N extra photos"; the request emails admins and records an event. Admins grant slots (`reason: gift`).
- Every client-visible route goes through `loadProject` / `loadPhoto` from M1; ownership never comes from the request.
- Commit after every task; conventional prefixes; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File structure

```
src/server/
  db/schema.ts                    + projects.selectionVersion; migration 0001
  fs/index.ts                     buildProjection(db,row) shared by rescan + writeProjection (computes allowance.slots)
  fs/photos.ts                    after indexing: transitions.onCullingMediaIndexed()
  domain/selection.ts             entitlement(), summary(), setPick(), grantSlots(), setIncluded(), recompute()
  domain/transitions.ts           onCullingMediaIndexed(), finishRound(), cancelRound(), adminRecipients()
  domain/comments.ts              addComment(), listComments(), resolveComment(), commentsAllowed()
  email/templates.ts              + culling_finished, extras_requested
  http/routes/selection.ts        GET selection, POST picks, POST finish, POST extras-request, admin grant/allowance/cancel-round
  http/routes/comments.ts         GET/POST photo comments, POST resolve
  http/routes/projects.ts         project detail gains selection summary, comments toggles, progress; photos gain pick/comment fields
  app.ts                          mount new routes
src/web/
  router.ts                       useRoute(), navigate()
  App.tsx                         routes: / (list), /p/:id (home), /p/:id/cull (grid + viewer)
  pages/ProjectHome.tsx
  pages/Cull.tsx                  grid, filter, bottom bar, finish sheet, extras request
  components/Viewer.tsx           full-screen viewer, heart, comments, region drawing, video
  components/Sheet.tsx            bottom sheet
tests/
  domain/selection.test.ts, domain/transitions.test.ts, domain/comments.test.ts
  http/portal.test.ts             routes end-to-end via app.request
  e2e/culling.spec.ts + tests/e2e/server.ts   Playwright (separate npm script)
docs/gates/m2-culling.md
```

---

### Task 1: `selectionVersion` column and shared projection builder

**Files:**
- Modify: `src/server/db/schema.ts` (projects), `src/server/fs/index.ts`
- Create: migration via `npm run db:generate`, `tests/fs/projection.test.ts`

**Interfaces:**
- Produces: `projects.selectionVersion: integer, default 1`; `buildProjection(db: Db, row: ProjectRow): ProjectJson` (stored human fields + `id`, `stateVersion`, `state`, `allowance.slots = included + Σ slot_grants`); `writeProjection(db, photosDir, projectId)` now uses it; `rescan` drift check uses it.

- [ ] **Step 1: Add the column and regenerate**

In `src/server/db/schema.ts` inside `projects`, after `currentRound`: `selectionVersion: integer('selection_version').notNull().default(1),`

Run: `npm run db:generate` → `src/server/db/migrations/0001_*.sql` adds the column. Run `npx vitest run tests/db.test.ts` to confirm migrations still apply.

- [ ] **Step 2: Write the failing test**

`tests/fs/projection.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { projects, slotGrants } from '../../src/server/db/schema.js';
import { rescan, writeProjection, buildProjection } from '../../src/server/fs/index.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';

describe('projection', () => {
  it('projects allowance.slots as included plus grants, and rescan does not flag it as drift', async () => {
    const root = await tmpDir(); const db = openDb(':memory:'); migrate(db);
    const p = defaultProjectJson('W'); p.allowance = { included: 40, extraPrice: 1500, slots: 40 };
    await mkdir(join(root, 'Clients/A/W'), { recursive: true });
    await writeJsonAtomic(join(root, 'Clients/A/client.json'), defaultClientJson('A'));
    await writeJsonAtomic(join(root, 'Clients/A/W/project.json'), p);
    await rescan(db, root);
    db.insert(slotGrants).values({ id: 'g1', projectId: p.id!, delta: 3, reason: 'gift', actor: 'owner@x' }).run();
    const row = db.select().from(projects).where(eq(projects.id, p.id!)).get()!;
    expect(buildProjection(db, row).allowance.slots).toBe(43);
    await writeProjection(db, root, p.id!);
    expect(JSON.parse(await readFile(join(root, 'Clients/A/W/project.json'), 'utf8')).allowance.slots).toBe(43);
    const r = await rescan(db, root);
    expect(r.issues).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/fs/projection.test.ts` → FAIL: `buildProjection` is not exported.

- [ ] **Step 4: Implement**

In `src/server/fs/index.ts`, add the import `import { slotGrants } from '../db/schema.js';` (extend the existing schema import) and `import { sum } from 'drizzle-orm';` (extend the existing drizzle import), then add:
```ts
export type ProjectRow = typeof projects.$inferSelect;

export function entitlementOf(db: Db, row: ProjectRow): number {
  const included = ProjectJson.parse(row.metadataJson).allowance.included;
  const granted = db.select({ s: sum(slotGrants.delta) }).from(slotGrants).where(eq(slotGrants.projectId, row.id)).get()?.s;
  return included + Number(granted ?? 0);
}

/** The file the database says this project should have: human fields as stored, machine fields from columns. */
export function buildProjection(db: Db, row: ProjectRow): ProjectJson {
  const stored = ProjectJson.parse(row.metadataJson);
  return {
    ...stored, id: row.id, stateVersion: row.stateVersion,
    state: { booking: row.bookingState, production: row.productionState, archivedAt: row.archivedAt },
    allowance: { ...stored.allowance, slots: entitlementOf(db, row) },
  };
}
```
Replace the body of `writeProjection` so it calls `buildProjection(db, row)`, stores it back into `metadataJson`, and writes the file. In `rescan`, replace the inline `projection` construction (`const stored = ...; const projection: ProjectJson = { ...stored, id, stateVersion: ..., state: ... }`) with `const projection = buildProjection(tx as unknown as Db, existing);`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/fs` → all pass (existing identity tests included).

- [ ] **Step 6: Commit**

```bash
git add src/server/db src/server/fs/index.ts tests/fs/projection.test.ts
git commit -m "feat: selection_version column; shared projection builder computes allowance.slots"
```

---

### Task 2: Selection domain — entitlement, picks, recompute, grants

**Files:**
- Create: `src/server/domain/selection.ts`, `tests/domain/selection.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class Conflict extends Error { selectionVersion: number }
  export class SelectionError extends Error { code: 'locked' | 'unknown_photo' | 'not_culling' | 'below_submitted' }
  export type SelectionSummary = { round: number; selectionVersion: number; included: number; entitlement: number; submitted: number; confirmed: number; pending: number; deficit: number; extraPrice: number };
  export function entitlement(db, projectId): number
  export function summary(db, projectId): SelectionSummary
  export function recompute(db, projectId): void            // runs inside caller's transaction or standalone
  export function setPick(db, o: { projectId; photoId; picked: boolean; byEmail: string; expectedVersion: number }): SelectionSummary
  export function grantSlots(db, photosDir, o: { projectId; delta: number; reason: 'gift' | 'purchase' | 'refund' | 'release'; actor: string; reference?: string }): Promise<SelectionSummary>
  export function setIncluded(db, photosDir, o: { projectId; included: number; actor: string }): Promise<SelectionSummary>
  export function currentPicks(db, projectId): { photoId: string; byEmail: string; state: 'confirmed' | 'pending'; round: number; locked: boolean }[]
  ```
- `setPick` rules: photo must belong to the project, be stage `culling`, not missing; a photo whose pick belongs to a submitted round (`round < currentRound`) is `locked` → `SelectionError('locked')`; unpick of a non-existent pick is a no-op that still bumps nothing. On success `selectionVersion += 1`, recompute, event `picked` / `unpicked`.

- [ ] **Step 1: Write the failing test**

`tests/domain/selection.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, photos, picks, events } from '../../src/server/db/schema.js';
import { setPick, summary, grantSlots, setIncluded, currentPicks, Conflict, SelectionError } from '../../src/server/domain/selection.js';
import { defaultProjectJson } from '../../src/server/fs/schemas.js';

async function seed(included = 2) {
  const root = await tmpDir(); await mkdir(join(root, 'Clients/A/W'), { recursive: true });
  const db = openDb(':memory:'); migrate(db);
  const meta = defaultProjectJson('W'); meta.id = 'p1'; meta.allowance = { included, extraPrice: 1500, slots: included };
  db.insert(clients).values({ id: 'c1', folderPath: 'Clients/A', name: 'A', emails: ['s@x', 't@x'] }).run();
  db.insert(projects).values({ id: 'p1', clientId: 'c1', folderPath: 'Clients/A/W', productionState: 'culling', metadataJson: meta as Record<string, unknown> }).run();
  for (const n of ['a', 'b', 'c', 'd']) db.insert(photos).values({ id: n, projectId: 'p1', relPath: `raw/${n}.dng`, stage: 'culling', kind: 'photo', checksum: n }).run();
  db.insert(photos).values({ id: 'f', projectId: 'p1', relPath: 'finals/f.jpg', stage: 'final', kind: 'photo', checksum: 'f' }).run();
  return { db, root };
}
const v = (db: ReturnType<typeof openDb>) => db.select({ v: projects.selectionVersion }).from(projects).where(eq(projects.id, 'p1')).get()!.v;

describe('selection', () => {
  it('two emails share one selection; a photo counts once', () => {
    const { db } = seed();
    setPick(db, { projectId: 'p1', photoId: 'a', picked: true, byEmail: 's@x', expectedVersion: v(db) });
    setPick(db, { projectId: 'p1', photoId: 'a', picked: true, byEmail: 't@x', expectedVersion: v(db) });
    const s = summary(db, 'p1');
    expect(s.confirmed).toBe(1); expect(s.pending).toBe(0); expect(s.entitlement).toBe(2);
    expect(currentPicks(db, 'p1')).toHaveLength(1);
  });
  it('confirms in picked_at order and marks the overflow pending', () => {
    const { db } = seed(2);
    for (const [i, id] of ['a', 'b', 'c'].entries()) { db.$client.prepare('select 1').get(); setPick(db, { projectId: 'p1', photoId: id, picked: true, byEmail: 's@x', expectedVersion: v(db) }); db.update(picks).set({ pickedAt: `2026-01-01T00:00:0${i}Z` }).where(eq(picks.photoId, id)).run(); }
    const { recompute } = require('../../src/server/domain/selection.js'); void recompute;
    setPick(db, { projectId: 'p1', photoId: 'd', picked: true, byEmail: 's@x', expectedVersion: v(db) });
    const rows = Object.fromEntries(currentPicks(db, 'p1').map((p) => [p.photoId, p.state]));
    expect(rows).toEqual({ a: 'confirmed', b: 'confirmed', c: 'pending', d: 'pending' });
    expect(summary(db, 'p1')).toMatchObject({ confirmed: 2, pending: 2 });
  });
  it('unpicking a confirmed pick promotes the oldest pending one', () => {
    const { db } = seed(1);
    setPick(db, { projectId: 'p1', photoId: 'a', picked: true, byEmail: 's@x', expectedVersion: v(db) });
    setPick(db, { projectId: 'p1', photoId: 'b', picked: true, byEmail: 's@x', expectedVersion: v(db) });
    expect(currentPicks(db, 'p1').find((p) => p.photoId === 'b')?.state).toBe('pending');
    setPick(db, { projectId: 'p1', photoId: 'a', picked: false, byEmail: 't@x', expectedVersion: v(db) });
    expect(currentPicks(db, 'p1')).toEqual([expect.objectContaining({ photoId: 'b', state: 'confirmed' })]);
  });
  it('rejects a stale version with the current one attached', () => {
    const { db } = seed();
    const stale = v(db);
    setPick(db, { projectId: 'p1', photoId: 'a', picked: true, byEmail: 's@x', expectedVersion: stale });
    let err: unknown; try { setPick(db, { projectId: 'p1', photoId: 'b', picked: true, byEmail: 't@x', expectedVersion: stale }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Conflict); expect((err as Conflict).selectionVersion).toBe(stale + 1);
    expect(currentPicks(db, 'p1')).toHaveLength(1);
  });
  it('grants promote pending picks; a negative grant demotes and reports a deficit only against submitted picks', async () => {
    const { db, root } = seed(1);
    setPick(db, { projectId: 'p1', photoId: 'a', picked: true, byEmail: 's@x', expectedVersion: v(db) });
    setPick(db, { projectId: 'p1', photoId: 'b', picked: true, byEmail: 's@x', expectedVersion: v(db) });
    let s = await grantSlots(db, root, { projectId: 'p1', delta: 1, reason: 'gift', actor: 'owner@x' });
    expect(s).toMatchObject({ entitlement: 2, confirmed: 2, pending: 0, deficit: 0 });
    s = await grantSlots(db, root, { projectId: 'p1', delta: -1, reason: 'refund', actor: 'owner@x', reference: 're_1' });
    expect(s).toMatchObject({ entitlement: 1, confirmed: 1, pending: 1, deficit: 0 });
    await expect(grantSlots(db, root, { projectId: 'p1', delta: -5, reason: 'refund', actor: 'owner@x', reference: 're_1' })).rejects.toThrow(/UNIQUE/); // same reference twice
  });
  it('submitted-round picks are locked and count first', () => {
    const { db } = seed(2);
    db.insert(picks).values({ projectId: 'p1', photoId: 'a', round: 1, byEmail: 's@x', state: 'confirmed', pickedAt: '2026-01-01T00:00:00Z' }).run();
    db.update(projects).set({ currentRound: 2 }).where(eq(projects.id, 'p1')).run();
    expect(() => setPick(db, { projectId: 'p1', photoId: 'a', picked: false, byEmail: 's@x', expectedVersion: v(db) })).toThrow(SelectionError);
    setPick(db, { projectId: 'p1', photoId: 'b', picked: true, byEmail: 's@x', expectedVersion: v(db) });
    setPick(db, { projectId: 'p1', photoId: 'c', picked: true, byEmail: 's@x', expectedVersion: v(db) });
    expect(summary(db, 'p1')).toMatchObject({ submitted: 1, confirmed: 1, pending: 1, round: 2 });
    expect(currentPicks(db, 'p1').find((p) => p.photoId === 'a')?.locked).toBe(true);
  });
  it('a negative grant below the submitted count is a deficit; setIncluded refuses to go below submitted', async () => {
    const { db, root } = seed(1);
    db.insert(picks).values({ projectId: 'p1', photoId: 'a', round: 1, byEmail: 's@x', state: 'confirmed' }).run();
    db.update(projects).set({ currentRound: 2 }).where(eq(projects.id, 'p1')).run();
    const s = await grantSlots(db, root, { projectId: 'p1', delta: -1, reason: 'refund', actor: 'owner@x' });
    expect(s.deficit).toBe(1);
    await expect(setIncluded(db, root, { projectId: 'p1', included: 0, actor: 'owner@x' })).rejects.toThrow(SelectionError);
    expect((await setIncluded(db, root, { projectId: 'p1', included: 5, actor: 'owner@x' })).entitlement).toBe(4);
  });
  it('refuses picks on finals, missing, or foreign photos and when not culling', () => {
    const { db } = seed();
    expect(() => setPick(db, { projectId: 'p1', photoId: 'f', picked: true, byEmail: 's@x', expectedVersion: v(db) })).toThrow(SelectionError);
    expect(() => setPick(db, { projectId: 'p1', photoId: 'zzz', picked: true, byEmail: 's@x', expectedVersion: v(db) })).toThrow(SelectionError);
    db.update(projects).set({ productionState: 'editing' }).where(eq(projects.id, 'p1')).run();
    expect(() => setPick(db, { projectId: 'p1', photoId: 'a', picked: true, byEmail: 's@x', expectedVersion: v(db) })).toThrow(/not_culling/);
    expect(db.select().from(events).all().filter((e) => e.type === 'picked')).toHaveLength(0);
  });
});
```
Remove the two stray lines in the second test that reference `require`/`recompute` and the `db.$client.prepare('select 1').get()` no-op; they are not needed (the test edits `picked_at` directly, then the next `setPick` triggers recompute).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/domain/selection.test.ts` → FAIL: missing module.

- [ ] **Step 3: Implement**

`src/server/domain/selection.ts`:
```ts
import { and, eq, lt, asc, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, picks, slotGrants, events } from '../db/schema.js';
import { ProjectJson } from '../fs/schemas.js';
import { entitlementOf, writeProjection } from '../fs/index.js';
import { newId } from '../fs/ids.js';

export class Conflict extends Error { constructor(public selectionVersion: number) { super('conflict'); this.name = 'Conflict'; } }
export class SelectionError extends Error {
  constructor(public code: 'locked' | 'unknown_photo' | 'not_culling' | 'below_submitted') { super(code); this.name = 'SelectionError'; }
}
export type SelectionSummary = { round: number; selectionVersion: number; included: number; entitlement: number; submitted: number; confirmed: number; pending: number; deficit: number; extraPrice: number };

function project(db: Db, id: string) {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw new Error(`unknown project ${id}`);
  return row;
}
export function entitlement(db: Db, projectId: string): number { return entitlementOf(db, project(db, projectId)); }

/** Submitted rounds stay confirmed; current-round picks are confirmed in picked_at order up to what is left. */
export function recompute(db: Db, projectId: string): void {
  const row = project(db, projectId);
  const ent = entitlementOf(db, row);
  const submitted = db.select({ n: sql<number>`count(*)` }).from(picks).where(and(eq(picks.projectId, projectId), lt(picks.round, row.currentRound))).get()!.n;
  const current = db.select().from(picks).where(and(eq(picks.projectId, projectId), eq(picks.round, row.currentRound))).orderBy(asc(picks.pickedAt), asc(picks.photoId)).all();
  let free = Math.max(0, ent - submitted);
  for (const p of current) {
    const state = free > 0 ? 'confirmed' : 'pending'; if (free > 0) free--;
    if (p.state !== state) db.update(picks).set({ state }).where(and(eq(picks.projectId, projectId), eq(picks.photoId, p.photoId))).run();
  }
}

export function summary(db: Db, projectId: string): SelectionSummary {
  const row = project(db, projectId); const meta = ProjectJson.parse(row.metadataJson);
  const ent = entitlementOf(db, row);
  const all = db.select().from(picks).where(eq(picks.projectId, projectId)).all();
  const submitted = all.filter((p) => p.round < row.currentRound).length;
  const cur = all.filter((p) => p.round === row.currentRound);
  return {
    round: row.currentRound, selectionVersion: row.selectionVersion, included: meta.allowance.included, entitlement: ent, submitted,
    confirmed: cur.filter((p) => p.state === 'confirmed').length, pending: cur.filter((p) => p.state === 'pending').length,
    deficit: Math.max(0, submitted - ent), extraPrice: meta.allowance.extraPrice,
  };
}

export function currentPicks(db: Db, projectId: string) {
  const row = project(db, projectId);
  return db.select().from(picks).where(eq(picks.projectId, projectId)).all()
    .map((p) => ({ photoId: p.photoId, byEmail: p.byEmail, state: p.state, round: p.round, locked: p.round < row.currentRound }));
}

export function setPick(db: Db, o: { projectId: string; photoId: string; picked: boolean; byEmail: string; expectedVersion: number }): SelectionSummary {
  return db.transaction((tx) => {
    const d = tx as unknown as Db;
    const row = project(d, o.projectId);
    if (row.selectionVersion !== o.expectedVersion) throw new Conflict(row.selectionVersion);
    if (row.productionState !== 'culling') throw new SelectionError('not_culling');
    const ph = d.select().from(photos).where(and(eq(photos.id, o.photoId), eq(photos.projectId, o.projectId))).get();
    if (!ph || ph.stage !== 'culling' || ph.missing) throw new SelectionError('unknown_photo');
    const existing = d.select().from(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.photoId, o.photoId))).get();
    if (existing && existing.round < row.currentRound) throw new SelectionError('locked');
    if (o.picked && !existing) {
      d.insert(picks).values({ projectId: o.projectId, photoId: o.photoId, round: row.currentRound, byEmail: o.byEmail.toLowerCase(), state: 'pending' }).run();
      d.insert(events).values({ projectId: o.projectId, actor: o.byEmail.toLowerCase(), type: 'picked', payload: { photoId: o.photoId } }).run();
    } else if (!o.picked && existing) {
      d.delete(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.photoId, o.photoId))).run();
      d.insert(events).values({ projectId: o.projectId, actor: o.byEmail.toLowerCase(), type: 'unpicked', payload: { photoId: o.photoId } }).run();
    }
    d.update(projects).set({ selectionVersion: row.selectionVersion + 1 }).where(eq(projects.id, o.projectId)).run();
    recompute(d, o.projectId);
    return summary(d, o.projectId);
  });
}

export async function grantSlots(db: Db, photosDir: string, o: { projectId: string; delta: number; reason: 'gift' | 'purchase' | 'refund' | 'release'; actor: string; reference?: string }): Promise<SelectionSummary> {
  db.transaction((tx) => {
    const d = tx as unknown as Db;
    d.insert(slotGrants).values({ id: newId(), projectId: o.projectId, delta: o.delta, reason: o.reason, actor: o.actor, reference: o.reference ?? null }).run();
    d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'slots_granted', payload: { delta: o.delta, reason: o.reason, reference: o.reference ?? null } }).run();
    d.update(projects).set({ selectionVersion: sql`${projects.selectionVersion} + 1` }).where(eq(projects.id, o.projectId)).run();
    recompute(d, o.projectId);
  });
  await writeProjection(db, photosDir, o.projectId);
  return summary(db, o.projectId);
}

export async function setIncluded(db: Db, photosDir: string, o: { projectId: string; included: number; actor: string }): Promise<SelectionSummary> {
  db.transaction((tx) => {
    const d = tx as unknown as Db;
    const row = project(d, o.projectId); const meta = ProjectJson.parse(row.metadataJson);
    const submitted = d.select({ n: sql<number>`count(*)` }).from(picks).where(and(eq(picks.projectId, o.projectId), lt(picks.round, row.currentRound))).get()!.n;
    const granted = entitlementOf(d, row) - meta.allowance.included;
    if (o.included + granted < submitted) throw new SelectionError('below_submitted');
    meta.allowance.included = o.included;
    d.update(projects).set({ metadataJson: meta as Record<string, unknown>, selectionVersion: row.selectionVersion + 1 }).where(eq(projects.id, o.projectId)).run();
    d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'allowance_changed', payload: { included: o.included } }).run();
    recompute(d, o.projectId);
  });
  await writeProjection(db, photosDir, o.projectId);
  return summary(db, o.projectId);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/domain/selection.test.ts` → 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/domain/selection.ts tests/domain/selection.test.ts
git commit -m "feat: shared selection with derived entitlement, recompute, optimistic concurrency, grants"
```

---

### Task 3: Transitions — ingest opens culling, finish round, cancel round

**Files:**
- Create: `src/server/domain/transitions.ts`, `tests/domain/transitions.test.ts`
- Modify: `src/server/fs/photos.ts` (call `onCullingMediaIndexed` at the end of `indexProjectMedia`), `src/server/email/templates.ts` (+ `culling_finished`, `extras_requested`)

**Interfaces:**
- Produces:
  ```ts
  export class TransitionError extends Error { code: 'not_culling' | 'no_picks' | 'pending_picks' | 'unpaid_extras' | 'needs_review' | 'deficit' | 'not_active' }
  export function onCullingMediaIndexed(db, photosDir, projectId): Promise<boolean>   // true when production moved to culling
  export function finishRound(db, photosDir, o: { projectId; actor: string; expectedVersion: number; baseUrl: string }): Promise<{ round: number; photoIds: string[] }>
  export function cancelRound(db, photosDir, o: { projectId; actor: string }): Promise<void>
  export function adminRecipients(db, projectId): string[]   // assignedTo if it is a user, else every user
  export function requestExtras(db, o: { projectId; count: number; byEmail: string; baseUrl: string }): void   // local mode
  ```
- Templates: `culling_finished` vars `{ studio, project, count, by, url }`; `extras_requested` vars `{ studio, project, count, by, url }`.

- [ ] **Step 1: Write the failing test**

`tests/domain/transitions.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers.js';
import { makeTiffAs } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { projects, picks, events, jobs, users, invoices } from '../../src/server/db/schema.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia } from '../../src/server/fs/photos.js';
import { writeJsonAtomic, readJson } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson, ProjectJson } from '../../src/server/fs/schemas.js';
import { setPick } from '../../src/server/domain/selection.js';
import { finishRound, cancelRound, requestExtras, TransitionError, adminRecipients } from '../../src/server/domain/transitions.js';

async function seed(included = 3) {
  const root = await tmpDir(); const db = openDb(':memory:'); migrate(db);
  const p = defaultProjectJson('W'); p.allowance = { included, extraPrice: 1500, slots: included }; p.assignedTo = 'sam@x';
  await mkdir(join(root, 'Clients/A/W/raw'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/A/client.json'), { ...defaultClientJson('A'), emails: ['s@x'] });
  await writeJsonAtomic(join(root, 'Clients/A/W/project.json'), p);
  db.insert(users).values([{ id: 'u1', email: 'owner@x', role: 'owner' }, { id: 'u2', email: 'sam@x', role: 'member' }]).run();
  await rescan(db, root);
  return { db, root, pid: p.id!, dir: join(root, 'Clients/A/W') };
}
const prod = (db: ReturnType<typeof openDb>, id: string) => db.select().from(projects).where(eq(projects.id, id)).get()!;
const pick = (db: ReturnType<typeof openDb>, pid: string, photoId: string, picked = true) => setPick(db, { projectId: pid, photoId, picked, byEmail: 's@x', expectedVersion: prod(db, pid).selectionVersion });

describe('transitions', () => {
  it('the first usable RAW moves not_started → culling, bumps stateVersion, projects to disk; later files never regress', async () => {
    const { db, root, pid, dir } = await seed();
    expect(prod(db, pid).productionState).toBe('not_started');
    await makeTiffAs(join(dir, 'raw/a.dng'));
    await indexProjectMedia(db, root, pid);
    const row = prod(db, pid);
    expect(row.productionState).toBe('culling'); expect(row.stateVersion).toBe(2);
    const file = await readJson(join(dir, 'project.json'), ProjectJson);
    expect(file.ok && file.data.state.production).toBe('culling');
    db.update(projects).set({ productionState: 'editing' }).where(eq(projects.id, pid)).run();
    await makeTiffAs(join(dir, 'raw/b.dng')); await indexProjectMedia(db, root, pid);
    expect(prod(db, pid).productionState).toBe('editing');
  });
  it('finish under allowance freezes the round, locks picks, opens round 2, moves to editing, emails the assignee', async () => {
    const { db, root, pid, dir } = await seed(40);
    for (const n of ['a', 'b']) await makeTiffAs(join(dir, `raw/${n}.dng`));
    await indexProjectMedia(db, root, pid);
    const ids = db.select().from(picks).all(); void ids;
    const photoIds = db.$client.prepare("select id from photos where stage='culling' order by rel_path").all().map((r) => (r as { id: string }).id);
    pick(db, pid, photoIds[0]!); pick(db, pid, photoIds[1]!);
    const r = await finishRound(db, root, { projectId: pid, actor: 's@x', expectedVersion: prod(db, pid).selectionVersion, baseUrl: 'https://g' });
    expect(r).toEqual({ round: 1, photoIds: [photoIds[0], photoIds[1]] });
    const row = prod(db, pid);
    expect(row.productionState).toBe('editing'); expect(row.currentRound).toBe(2);
    const ev = db.select().from(events).all().find((e) => e.type === 'finished_culling')!;
    expect(ev.payload).toEqual({ round: 1, photoIds: [photoIds[0], photoIds[1]] });
    const job = db.select().from(jobs).all().find((j) => j.kind === 'send_email')!;
    expect(job.payload).toMatchObject({ to: 'sam@x', template: 'culling_finished', vars: { count: '2' } });
    expect(() => pick(db, pid, photoIds[0]!, false)).toThrow(/not_culling/);
  });
  it('refuses to finish with zero picks, pending picks, an unpaid extras invoice, a review item, or when not culling', async () => {
    const { db, root, pid, dir } = await seed(1);
    for (const n of ['a', 'b']) await makeTiffAs(join(dir, `raw/${n}.dng`));
    await indexProjectMedia(db, root, pid);
    const [a, b] = db.$client.prepare("select id from photos order by rel_path").all().map((r) => (r as { id: string }).id) as [string, string];
    const fin = () => finishRound(db, root, { projectId: pid, actor: 's@x', expectedVersion: prod(db, pid).selectionVersion, baseUrl: 'https://g' });
    await expect(fin()).rejects.toMatchObject({ code: 'no_picks' });
    pick(db, pid, a); pick(db, pid, b);
    await expect(fin()).rejects.toMatchObject({ code: 'pending_picks' });
    pick(db, pid, b, false);
    db.insert(invoices).values({ id: 'i1', projectId: pid, kind: 'extras', amount: 1500, currency: 'usd' }).run();
    await expect(fin()).rejects.toMatchObject({ code: 'unpaid_extras' });
    db.update(invoices).set({ voidedAt: 'now' }).where(eq(invoices.id, 'i1')).run();
    db.insert(invoices).values({ id: 'i2', projectId: pid, kind: 'adjustment', amount: 0, currency: 'usd', needsReview: true }).run();
    await expect(fin()).rejects.toMatchObject({ code: 'needs_review' });
    db.update(invoices).set({ needsReview: false }).where(eq(invoices.id, 'i2')).run();
    await expect(finishRound(db, root, { projectId: pid, actor: 's@x', expectedVersion: 0, baseUrl: 'https://g' })).rejects.toThrow(/conflict/);
    await expect(fin()).resolves.toMatchObject({ round: 1 });
    await expect(fin()).rejects.toMatchObject({ code: 'not_culling' });
    expect(prod(db, pid).stateVersion).toBe(3); // culling (2) → editing (3)
  });
  it('cancel round clears current picks and records an event; extras request emails admins once per count', async () => {
    const { db, root, pid, dir } = await seed(1);
    await makeTiffAs(join(dir, 'raw/a.dng')); await indexProjectMedia(db, root, pid);
    const a = db.$client.prepare('select id from photos').get() as { id: string };
    pick(db, pid, a.id);
    await cancelRound(db, root, { projectId: pid, actor: 'owner@x' });
    expect(db.select().from(picks).all()).toHaveLength(0);
    expect(db.select().from(events).all().some((e) => e.type === 'round_cancelled')).toBe(true);
    requestExtras(db, { projectId: pid, count: 3, byEmail: 's@x', baseUrl: 'https://g' });
    requestExtras(db, { projectId: pid, count: 3, byEmail: 's@x', baseUrl: 'https://g' });
    const mails = db.select().from(jobs).all().filter((j) => j.kind === 'send_email');
    expect(mails).toHaveLength(1); expect(mails[0]!.payload).toMatchObject({ to: 'sam@x', template: 'extras_requested', vars: { count: '3' } });
    expect(adminRecipients(db, pid)).toEqual(['sam@x']);
    db.delete(users).where(eq(users.email, 'sam@x')).run();
    expect(adminRecipients(db, pid)).toEqual(['owner@x']);
  });
});
```
Delete the stray `const ids = ...; void ids;` line in the second test.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/domain/transitions.test.ts` → FAIL: missing module.

- [ ] **Step 3: Add the templates**

In `src/server/email/templates.ts`, extend `TemplateName` to `'magic_link' | 'test_delivery' | 'culling_finished' | 'extras_requested'` and add to `T`:
```ts
  culling_finished: (v) => ({
    subject: `${v.by} finished picking · ${v.project}`,
    text: `${v.by} picked ${v.count} photos for ${v.project}. Open the project:\n\n${v.url}`,
    html: shell(`${v.project}: picks are in`, `<p>${esc(v.by ?? '')} picked <strong>${esc(v.count ?? '')}</strong> photos.</p><p><a href="${esc(v.url ?? '')}">Open the project</a></p>`),
  }),
  extras_requested: (v) => ({
    subject: `${v.by} wants ${v.count} extra photos · ${v.project}`,
    text: `${v.by} asked for ${v.count} extra photos on ${v.project}. Grant them or send an invoice:\n\n${v.url}`,
    html: shell(`${v.project}: extra photos requested`, `<p>${esc(v.by ?? '')} asked for <strong>${esc(v.count ?? '')}</strong> extra photos.</p><p><a href="${esc(v.url ?? '')}">Open the project</a></p>`),
  }),
```

- [ ] **Step 4: Implement transitions**

`src/server/domain/transitions.ts`:
```ts
import { and, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, picks, events, users, invoices } from '../db/schema.js';
import { ProjectJson } from '../fs/schemas.js';
import { writeProjection } from '../fs/index.js';
import { sendEmail } from '../email/send.js';
import { getSetting } from '../db/settings.js';
import { Conflict, recompute, summary } from './selection.js';

export class TransitionError extends Error {
  constructor(public code: 'not_culling' | 'no_picks' | 'pending_picks' | 'unpaid_extras' | 'needs_review' | 'deficit' | 'not_active') { super(code); this.name = 'TransitionError'; }
}
const row = (db: Db, id: string) => { const r = db.select().from(projects).where(eq(projects.id, id)).get(); if (!r) throw new Error(`unknown project ${id}`); return r; };
const active = (r: ReturnType<typeof row>) => r.available && !r.transferPending && r.archivedAt === null && r.bookingState !== 'cancelled';

export function adminRecipients(db: Db, projectId: string): string[] {
  const meta = ProjectJson.parse(row(db, projectId).metadataJson);
  const all = db.select({ email: users.email }).from(users).all().map((u) => u.email);
  return meta.assignedTo && all.includes(meta.assignedTo) ? [meta.assignedTo] : all;
}

/** First usable culling photo: not_started | shot → culling. Never regresses a later state. */
export async function onCullingMediaIndexed(db: Db, photosDir: string, projectId: string): Promise<boolean> {
  const r = row(db, projectId);
  if (!active(r) || !['not_started', 'shot'].includes(r.productionState)) return false;
  const usable = db.select({ id: photos.id }).from(photos).where(and(eq(photos.projectId, projectId), eq(photos.stage, 'culling'), eq(photos.missing, false))).get();
  if (!usable) return false;
  db.transaction((tx) => {
    tx.update(projects).set({ productionState: 'culling', stateVersion: r.stateVersion + 1 }).where(and(eq(projects.id, projectId), eq(projects.stateVersion, r.stateVersion))).run();
    tx.insert(events).values({ projectId, actor: 'system', type: 'production_changed', payload: { from: r.productionState, to: 'culling' } }).run();
  });
  await writeProjection(db, photosDir, projectId);
  return true;
}

export async function finishRound(db: Db, photosDir: string, o: { projectId: string; actor: string; expectedVersion: number; baseUrl: string }): Promise<{ round: number; photoIds: string[] }> {
  const result = db.transaction((tx) => {
    const d = tx as unknown as Db; const r = row(d, o.projectId);
    if (r.selectionVersion !== o.expectedVersion) throw new Conflict(r.selectionVersion);
    if (!active(r)) throw new TransitionError('not_active');
    if (r.productionState !== 'culling') throw new TransitionError('not_culling');
    recompute(d, o.projectId);
    const s = summary(d, o.projectId);
    if (s.confirmed + s.pending === 0) throw new TransitionError('no_picks');
    if (s.pending > 0) throw new TransitionError('pending_picks');
    if (s.deficit > 0) throw new TransitionError('deficit');
    if (d.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.projectId, o.projectId), eq(invoices.kind, 'extras'), isNull(invoices.paidAt), isNull(invoices.voidedAt))).get()) throw new TransitionError('unpaid_extras');
    if (d.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.projectId, o.projectId), eq(invoices.needsReview, true))).get()) throw new TransitionError('needs_review');
    const photoIds = d.select({ id: picks.photoId }).from(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.round, r.currentRound))).orderBy(picks.pickedAt, picks.photoId).all().map((p) => p.id);
    d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'finished_culling', payload: { round: r.currentRound, photoIds } }).run();
    d.insert(events).values({ projectId: o.projectId, actor: 'system', type: 'production_changed', payload: { from: 'culling', to: 'editing' } }).run();
    d.update(projects).set({ productionState: 'editing', currentRound: r.currentRound + 1, stateVersion: r.stateVersion + 1, selectionVersion: r.selectionVersion + 1 }).where(eq(projects.id, o.projectId)).run();
    const meta = ProjectJson.parse(r.metadataJson); const studio = getSetting<string>(d, 'studioName') ?? 'OpenGallery';
    for (const to of adminRecipients(d, o.projectId))
      sendEmail(d, { to, template: 'culling_finished', vars: { studio, project: meta.title, count: String(photoIds.length), by: o.actor, url: `${o.baseUrl}/p/${o.projectId}` }, key: `culling_finished:${o.projectId}:${r.currentRound}:${to}` });
    return { round: r.currentRound, photoIds };
  });
  await writeProjection(db, photosDir, o.projectId);
  return result;
}

export async function cancelRound(db: Db, photosDir: string, o: { projectId: string; actor: string }): Promise<void> {
  db.transaction((tx) => {
    const d = tx as unknown as Db; const r = row(d, o.projectId);
    const n = d.delete(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.round, r.currentRound))).run().changes;
    d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'round_cancelled', payload: { round: r.currentRound, removed: n } }).run();
    d.update(projects).set({ selectionVersion: r.selectionVersion + 1 }).where(eq(projects.id, o.projectId)).run();
  });
  await writeProjection(db, photosDir, o.projectId);
}

/** Local mode: no payment; tell the studio. Idempotent per project/round/count. */
export function requestExtras(db: Db, o: { projectId: string; count: number; byEmail: string; baseUrl: string }): void {
  db.transaction((tx) => {
    const d = tx as unknown as Db; const r = row(d, o.projectId); const meta = ProjectJson.parse(r.metadataJson);
    const studio = getSetting<string>(d, 'studioName') ?? 'OpenGallery';
    d.insert(events).values({ projectId: o.projectId, actor: o.byEmail, type: 'extras_requested', payload: { count: o.count, round: r.currentRound } }).run();
    for (const to of adminRecipients(d, o.projectId))
      sendEmail(d, { to, template: 'extras_requested', vars: { studio, project: meta.title, count: String(o.count), by: o.byEmail, url: `${o.baseUrl}/p/${o.projectId}` }, key: `extras_requested:${o.projectId}:${r.currentRound}:${o.count}:${to}` });
  });
}
export { lt, ne, sql };
```
Remove the final `export { lt, ne, sql };` line and the unused imports (`lt`, `ne`, `sql`) once the file compiles; they exist only so the import line above is copy-safe.

In `src/server/fs/photos.ts`, add `import { onCullingMediaIndexed } from '../domain/transitions.js';` and, immediately before `return report;` at the end of `indexProjectMedia`, add:
```ts
  if (report.added > 0 || report.updated > 0) await onCullingMediaIndexed(db, photosDir, projectId);
```
(`domain/transitions` imports `fs/index`, and `fs/photos` imports `domain/transitions`; there is no cycle because `fs/index` does not import `fs/photos`.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/domain tests/fs` → all pass. If `tests/fs/photos.test.ts` fails because a project now transitions on index, that is expected behaviour; it should still pass as written since it asserts only on photos/jobs/events it created.

- [ ] **Step 6: Commit**

```bash
git add src/server/domain/transitions.ts src/server/fs/photos.ts src/server/email/templates.ts tests/domain/transitions.test.ts
git commit -m "feat: guarded transitions: ingest opens culling, finish round freezes and emails, cancel round, extras request"
```

---

### Task 4: Comments domain

**Files:**
- Create: `src/server/domain/comments.ts`, `tests/domain/comments.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class CommentError extends Error { code: 'disabled' | 'invalid' | 'unknown_photo' }
  export type CommentInput = { text: string; x?: number; y?: number; w?: number; h?: number; t?: number };
  export function commentsAllowed(db, projectId, stage: 'culling' | 'final'): boolean
  export function addComment(db, o: { photoId: string; author: string; isAdmin: boolean; input: CommentInput }): CommentRow
  export function listComments(db, photoId): CommentRow[]
  export function resolveComment(db, o: { commentId: string; actor: string; resolved: boolean }): CommentRow
  export function commentCounts(db, projectId): Record<string, { open: number; total: number }>   // by photoId
  ```
- `CommentRow = typeof comments.$inferSelect`. Region for photos only (all four of x,y,w,h in 0–1, w,h > 0, x+w ≤ 1, y+h ≤ 1); `t` for videos only (≥ 0). Text trimmed, 1–2000 chars. Stage comes from the photo. Clients need `project.comments[stage]` on; admins bypass. Each add records event `commented`; resolve records `comment_resolved`.

- [ ] **Step 1: Write the failing test**

`tests/domain/comments.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, photos, events } from '../../src/server/db/schema.js';
import { addComment, listComments, resolveComment, commentsAllowed, commentCounts, CommentError } from '../../src/server/domain/comments.js';
import { defaultProjectJson } from '../../src/server/fs/schemas.js';

function seed(toggles = { culling: true, finals: true }) {
  const db = openDb(':memory:'); migrate(db);
  const meta = defaultProjectJson('W'); meta.id = 'p1'; meta.comments = toggles;
  db.insert(clients).values({ id: 'c1', folderPath: 'Clients/A', name: 'A', emails: ['s@x'] }).run();
  db.insert(projects).values({ id: 'p1', clientId: 'c1', folderPath: 'Clients/A/W', productionState: 'culling', metadataJson: meta as Record<string, unknown> }).run();
  db.insert(photos).values([
    { id: 'a', projectId: 'p1', relPath: 'raw/a.dng', stage: 'culling', kind: 'photo', checksum: 'a' },
    { id: 'v', projectId: 'p1', relPath: 'raw/v.mp4', stage: 'culling', kind: 'video', checksum: 'v' },
    { id: 'f', projectId: 'p1', relPath: 'finals/f.jpg', stage: 'final', kind: 'photo', checksum: 'f' },
  ]).run();
  return db;
}

describe('comments', () => {
  it('adds a region comment on a photo and a timestamp comment on a video', () => {
    const db = seed();
    const c = addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: '  soften the shadow ', x: 0.1, y: 0.2, w: 0.3, h: 0.3 } });
    expect(c).toMatchObject({ photoId: 'a', stage: 'culling', text: 'soften the shadow', x: 0.1, t: null, resolvedAt: null });
    const v = addComment(db, { photoId: 'v', author: 's@x', isAdmin: false, input: { text: 'cut here', t: 42.5 } });
    expect(v).toMatchObject({ t: 42.5, x: null });
    expect(listComments(db, 'a')).toHaveLength(1);
    expect(db.select().from(events).all().filter((e) => e.type === 'commented')).toHaveLength(2);
  });
  it('validates text, region bounds, and region-vs-timestamp by kind', () => {
    const db = seed();
    const bad = (input: Parameters<typeof addComment>[1]['input'], photoId = 'a') => expect(() => addComment(db, { photoId, author: 's@x', isAdmin: false, input })).toThrow(CommentError);
    bad({ text: '   ' }); bad({ text: 'x'.repeat(2001) });
    bad({ text: 'ok', x: 0.9, y: 0, w: 0.2, h: 0.1 });          // x+w > 1
    bad({ text: 'ok', x: 0, y: 0, w: 0, h: 0.1 });              // w = 0
    bad({ text: 'ok', x: 0.1, y: 0.1 });                        // partial region
    bad({ text: 'ok', t: 3 });                                  // timestamp on a photo
    bad({ text: 'ok', x: 0, y: 0, w: 0.5, h: 0.5 }, 'v');       // region on a video
    bad({ text: 'ok', t: -1 }, 'v');
    bad({ text: 'ok' }, 'nope');
    expect(addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'whole photo' } }).x).toBeNull();
  });
  it('respects the per-stage toggle for clients but not admins', () => {
    const db = seed({ culling: false, finals: true });
    expect(commentsAllowed(db, 'p1', 'culling')).toBe(false); expect(commentsAllowed(db, 'p1', 'final')).toBe(true);
    expect(() => addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'hi' } })).toThrow(/disabled/);
    expect(addComment(db, { photoId: 'a', author: 'owner@x', isAdmin: true, input: { text: 'hi' } }).author).toBe('owner@x');
    expect(addComment(db, { photoId: 'f', author: 's@x', isAdmin: false, input: { text: 'final ok' } }).stage).toBe('final');
  });
  it('resolves and unresolves, and counts open vs total per photo', () => {
    const db = seed();
    const c1 = addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'one' } });
    addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'two' } });
    expect(resolveComment(db, { commentId: c1.id, actor: 'owner@x', resolved: true }).resolvedAt).not.toBeNull();
    expect(commentCounts(db, 'p1')).toEqual({ a: { open: 1, total: 2 } });
    expect(resolveComment(db, { commentId: c1.id, actor: 'owner@x', resolved: false }).resolvedAt).toBeNull();
    expect(db.select().from(events).all().filter((e) => e.type === 'comment_resolved')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/domain/comments.test.ts` → FAIL: missing module.

- [ ] **Step 3: Implement**

`src/server/domain/comments.ts`:
```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, comments, events } from '../db/schema.js';
import { ProjectJson } from '../fs/schemas.js';
import { newId } from '../fs/ids.js';

export class CommentError extends Error { constructor(public code: 'disabled' | 'invalid' | 'unknown_photo') { super(code); this.name = 'CommentError'; } }
export type CommentRow = typeof comments.$inferSelect;
export type CommentInput = { text: string; x?: number; y?: number; w?: number; h?: number; t?: number };

export function commentsAllowed(db: Db, projectId: string, stage: 'culling' | 'final'): boolean {
  const row = db.select({ m: projects.metadataJson }).from(projects).where(eq(projects.id, projectId)).get();
  if (!row) return false;
  const c = ProjectJson.parse(row.m).comments;
  return stage === 'culling' ? c.culling : c.finals;
}

const unit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

export function addComment(db: Db, o: { photoId: string; author: string; isAdmin: boolean; input: CommentInput }): CommentRow {
  const ph = db.select().from(photos).where(eq(photos.id, o.photoId)).get();
  if (!ph) throw new CommentError('unknown_photo');
  if (!o.isAdmin && !commentsAllowed(db, ph.projectId, ph.stage)) throw new CommentError('disabled');
  const text = (o.input.text ?? '').trim();
  if (text.length < 1 || text.length > 2000) throw new CommentError('invalid');
  const { x, y, w, h, t } = o.input;
  const hasRegion = [x, y, w, h].some((n) => n !== undefined); const hasT = t !== undefined;
  if (hasRegion && hasT) throw new CommentError('invalid');
  if (hasRegion) {
    if (ph.kind !== 'photo') throw new CommentError('invalid');
    if (![x, y, w, h].every(unit) || w! <= 0 || h! <= 0 || x! + w! > 1 + 1e-9 || y! + h! > 1 + 1e-9) throw new CommentError('invalid');
  }
  if (hasT && (ph.kind !== 'video' || typeof t !== 'number' || !Number.isFinite(t) || t < 0)) throw new CommentError('invalid');
  const id = newId();
  db.transaction((tx) => {
    tx.insert(comments).values({ id, photoId: ph.id, author: o.author.toLowerCase(), stage: ph.stage, text, x: hasRegion ? x! : null, y: hasRegion ? y! : null, w: hasRegion ? w! : null, h: hasRegion ? h! : null, t: hasT ? t! : null }).run();
    tx.insert(events).values({ projectId: ph.projectId, actor: o.author.toLowerCase(), type: 'commented', payload: { photoId: ph.id, commentId: id } }).run();
  });
  return db.select().from(comments).where(eq(comments.id, id)).get()!;
}

export function listComments(db: Db, photoId: string): CommentRow[] {
  return db.select().from(comments).where(eq(comments.photoId, photoId)).orderBy(comments.createdAt).all();
}

export function resolveComment(db: Db, o: { commentId: string; actor: string; resolved: boolean }): CommentRow {
  const c = db.select().from(comments).where(eq(comments.id, o.commentId)).get();
  if (!c) throw new CommentError('unknown_photo');
  const ph = db.select({ projectId: photos.projectId }).from(photos).where(eq(photos.id, c.photoId)).get()!;
  db.transaction((tx) => {
    tx.update(comments).set({ resolvedAt: o.resolved ? new Date().toISOString() : null }).where(eq(comments.id, o.commentId)).run();
    tx.insert(events).values({ projectId: ph.projectId, actor: o.actor, type: 'comment_resolved', payload: { commentId: o.commentId, resolved: o.resolved } }).run();
  });
  return db.select().from(comments).where(eq(comments.id, o.commentId)).get()!;
}

export function commentCounts(db: Db, projectId: string): Record<string, { open: number; total: number }> {
  const rows = db.select({ photoId: comments.photoId, open: sql<number>`sum(case when ${comments.resolvedAt} is null then 1 else 0 end)`, total: sql<number>`count(*)` })
    .from(comments).innerJoin(photos, eq(photos.id, comments.photoId)).where(eq(photos.projectId, projectId)).groupBy(comments.photoId).all();
  return Object.fromEntries(rows.map((r) => [r.photoId, { open: Number(r.open), total: Number(r.total) }]));
}
export { and, isNull };
```
Drop the trailing `export { and, isNull };` and the unused imports once it compiles.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/domain/comments.test.ts` → 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/domain/comments.ts tests/domain/comments.test.ts
git commit -m "feat: comments domain with region/timestamp validation, per-stage toggles, resolve"
```

---

### Task 5: Portal API routes

**Files:**
- Create: `src/server/http/routes/selection.ts`, `src/server/http/routes/comments.ts`, `tests/http/portal.test.ts`
- Modify: `src/server/http/routes/projects.ts` (richer detail and photo list), `src/server/app.ts` (mount)

**Interfaces (HTTP):**
- `GET /api/projects/:id` → adds `selection: SelectionSummary`, `comments: { culling, finals }`, `progress: { done, total }` (done = submitted-round photos with `edit_state = 'done'`, total = submitted count), `viewerEmail` (session subject).
- `GET /api/projects/:id/photos` → each item adds `pick: null | { state, byEmail, locked }`, `comments: { open, total }`, `previewReady: boolean` (width not null). Culling stage only lists `stage = 'culling'` rows for clients while production is `culling` or `editing`; finals are listed as before. Add query `?stage=culling|final` (default: `culling` while production is `culling`/`editing`, else `final`).
- `GET /api/projects/:id/selection` → `{ summary, picks: currentPicks[] }`.
- `POST /api/projects/:id/picks` body `{ photoId, picked, selectionVersion }` → 200 `{ summary, picks }`; 409 `{ error: 'conflict', selectionVersion }`; 422 `{ error: code }` for `SelectionError`.
- `POST /api/projects/:id/finish` body `{ selectionVersion }` → 200 `{ round, count }`; 409 conflict; 422 `{ error: code }` for `TransitionError`.
- `POST /api/projects/:id/extras-request` body `{ count }` (1–500) → 200 `{ ok: true }`. Clients only.
- Admin only (`requireKind('admin')`): `POST /api/projects/:id/grant` `{ delta, reason?: 'gift' }` → summary; `POST /api/projects/:id/allowance` `{ included }` → summary or 422; `POST /api/projects/:id/cancel-round` → `{ ok }`.
- `GET /api/photos/:photoId/comments` → `CommentRow[]`; `POST /api/photos/:photoId/comments` body `CommentInput` → 201 row; 422 `{ error: code }`; `POST /api/comments/:id/resolve` `{ resolved }` admin only.
- A project `GET` by a client records a `viewed` event at most once per session per hour (in-process map keyed by `sessionId:projectId`).

- [ ] **Step 1: Write the failing test**

`tests/http/portal.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers.js';
import { makeTiffAs } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { loadConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/app.js';
import { createSetupToken } from '../../src/server/auth/bootstrap.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { makeEmailHandlers } from '../../src/server/email/send.js';
import { memoryTransport } from '../../src/server/email/transport.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia, makePreviewHandlers } from '../../src/server/fs/photos.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';
import { events } from '../../src/server/db/schema.js';

const SMTP = { type: 'smtp', url: 'smtp://u:p@h:587', from: 'S <s@x>' };
const linkFrom = (text: string) => text.match(/http:\/\/localhost:3000\/auth\/[A-Za-z0-9_-]+/)![0];
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

async function boot() {
  const photosDir = await tmpDir(); const dataDir = await tmpDir();
  await mkdir(join(photosDir, 'Clients'), { recursive: true });
  const config = loadConfig({ DATA_DIR: dataDir, PHOTOS_DIR: photosDir, BASE_URL: 'http://localhost:3000', SESSION_SECRET: 'x'.repeat(32) });
  const db = openDb(':memory:'); migrate(db);
  const app = createApp({ db, config, photosDir, webRoot: photosDir });
  const mail = memoryTransport();
  const handlers = { ...makeEmailHandlers(() => mail, 'localhost'), ...makePreviewHandlers(photosDir) };
  const drain = async () => { while ((await runOnce(db, handlers)) === 'ran') { /* */ } };
  const api = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) } });
  const post = (path: string, body: unknown, cookie: string) => api(path, { method: 'POST', body: JSON.stringify(body), cookie });
  const json = async <T,>(res: Response) => (await res.json()) as T;
  // owner
  const token = createSetupToken(db);
  await api('/api/setup', { method: 'POST', body: JSON.stringify({ token, ownerEmail: 'owner@x.com', studioName: 'S', email: SMTP }) }); await drain();
  const owner = cookieOf(await app.request(linkFrom(mail.sent.at(-1)!.text), { redirect: 'manual' }));
  // project with 3 raws, allowance 2, two client emails
  const c = defaultClientJson('Smith'); c.emails = ['sarah@x.com', 'tom@x.com'];
  const p = defaultProjectJson('Wedding'); p.allowance = { included: 2, extraPrice: 1500, slots: 2 };
  await mkdir(join(photosDir, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await writeJsonAtomic(join(photosDir, 'Clients/Smith/client.json'), c);
  await writeJsonAtomic(join(photosDir, 'Clients/Smith/Wedding/project.json'), p);
  for (const n of ['a', 'b', 'c']) await makeTiffAs(join(photosDir, `Clients/Smith/Wedding/raw/${n}.dng`));
  await rescan(db, photosDir); await indexProjectMedia(db, photosDir, p.id!); await drain();
  const signIn = async (email: string) => {
    const before = mail.sent.length;
    await post('/api/auth/request', { email }, ''); await drain();
    return cookieOf(await app.request(linkFrom(mail.sent[before]!.text), { redirect: 'manual' }));
  };
  const sarah = await signIn('sarah@x.com'); const tom = await signIn('tom@x.com');
  return { db, api, post, json, mail, drain, owner, sarah, tom, pid: p.id! };
}
type Summary = { selectionVersion: number; confirmed: number; pending: number; entitlement: number };
type PhotoItem = { id: string; pick: null | { state: string; byEmail: string; locked: boolean }; comments: { open: number; total: number }; previewReady: boolean };

describe('portal api', () => {
  it('walks a shared culling round: pick, conflict, extras request, grant, finish, locked', async () => {
    const { db, api, post, json, mail, drain, owner, sarah, tom, pid } = await boot();
    let detail = await json<{ selection: Summary; state: { production: string }; comments: { culling: boolean } }>(await api(`/api/projects/${pid}`, { cookie: sarah }));
    expect(detail.state.production).toBe('culling'); expect(detail.selection).toMatchObject({ entitlement: 2, confirmed: 0 });
    expect(db.select().from(events).all().filter((e) => e.type === 'viewed')).toHaveLength(1);
    await api(`/api/projects/${pid}`, { cookie: sarah });
    expect(db.select().from(events).all().filter((e) => e.type === 'viewed')).toHaveLength(1); // throttled
    const photos = await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: sarah }));
    expect(photos).toHaveLength(3); expect(photos.every((p) => p.previewReady)).toBe(true);
    const [a, b, c] = photos.map((p) => p.id) as [string, string, string];
    let v = detail.selection.selectionVersion;
    let r = await post(`/api/projects/${pid}/picks`, { photoId: a, picked: true, selectionVersion: v }, sarah);
    expect(r.status).toBe(200); v = (await json<{ summary: Summary }>(r)).summary.selectionVersion;
    // tom acts on a stale version → conflict with the current one
    r = await post(`/api/projects/${pid}/picks`, { photoId: b, picked: true, selectionVersion: v - 1 }, tom);
    expect(r.status).toBe(409); expect((await json<{ selectionVersion: number }>(r)).selectionVersion).toBe(v);
    r = await post(`/api/projects/${pid}/picks`, { photoId: b, picked: true, selectionVersion: v }, tom); v = (await json<{ summary: Summary }>(r)).summary.selectionVersion;
    r = await post(`/api/projects/${pid}/picks`, { photoId: c, picked: true, selectionVersion: v }, sarah);
    const s = (await json<{ summary: Summary }>(r)).summary; v = s.selectionVersion;
    expect(s).toMatchObject({ confirmed: 2, pending: 1 });
    // finish blocked by the pending pick
    r = await post(`/api/projects/${pid}/finish`, { selectionVersion: v }, sarah);
    expect(r.status).toBe(422); expect(await json<{ error: string }>(r)).toEqual({ error: 'pending_picks' });
    // local mode: request extras → studio emailed once
    const before = mail.sent.length;
    expect((await post(`/api/projects/${pid}/extras-request`, { count: 1 }, sarah)).status).toBe(200); await drain();
    expect(mail.sent.length).toBe(before + 1); expect(mail.sent.at(-1)!.subject).toMatch(/1 extra photos/);
    // client cannot grant; admin grants a gift → pending becomes confirmed
    expect((await post(`/api/projects/${pid}/grant`, { delta: 1 }, sarah)).status).toBe(401);
    r = await post(`/api/projects/${pid}/grant`, { delta: 1 }, owner);
    expect(await json<Summary>(r)).toMatchObject({ entitlement: 3, confirmed: 3, pending: 0 });
    // stale finish → 409; fresh finish → editing, picks locked, email to owner
    detail = await json<typeof detail>(await api(`/api/projects/${pid}`, { cookie: sarah })); v = detail.selection.selectionVersion;
    expect((await post(`/api/projects/${pid}/finish`, { selectionVersion: v - 1 }, sarah)).status).toBe(409);
    r = await post(`/api/projects/${pid}/finish`, { selectionVersion: v }, tom);
    expect(r.status).toBe(200); expect(await json<{ round: number; count: number }>(r)).toEqual({ round: 1, count: 3 });
    await drain(); expect(mail.sent.at(-1)).toMatchObject({ to: 'owner@x.com' });
    detail = await json<typeof detail>(await api(`/api/projects/${pid}`, { cookie: sarah }));
    expect(detail.state.production).toBe('editing');
    const after = await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: sarah }));
    expect(after.every((p) => p.pick?.locked)).toBe(true);
    detail = await json<typeof detail>(await api(`/api/projects/${pid}`, { cookie: sarah }));
    expect((await post(`/api/projects/${pid}/picks`, { photoId: a, picked: false, selectionVersion: detail.selection.selectionVersion }, sarah)).status).toBe(422);
  });
  it('comments: client adds within toggle, admin resolves, counts surface on photos', async () => {
    const { api, post, json, owner, sarah, pid } = await boot();
    const [a] = (await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: sarah }))).map((p) => p.id);
    let r = await post(`/api/photos/${a}/comments`, { text: 'soften', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, sarah);
    expect(r.status).toBe(201); const c = await json<{ id: string }>(r);
    expect((await post(`/api/photos/${a}/comments`, { text: '', }, sarah)).status).toBe(422);
    expect((await post(`/api/comments/${c.id}/resolve`, { resolved: true }, sarah)).status).toBe(401);
    expect((await post(`/api/comments/${c.id}/resolve`, { resolved: true }, owner)).status).toBe(200);
    expect(await json<unknown[]>(await api(`/api/photos/${a}/comments`, { cookie: sarah }))).toHaveLength(1);
    const photos = await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: sarah }));
    expect(photos.find((p) => p.id === a)?.comments).toEqual({ open: 0, total: 1 });
    // a stranger's session cannot see or post comments on this photo
    expect((await api(`/api/photos/${a}/comments`)).status).toBe(404);
    expect((await post(`/api/photos/${a}/comments`, { text: 'x' }, '')).status).toBe(404);
  });
  it('admin allowance and cancel-round; below-submitted refused', async () => {
    const { api, post, json, owner, sarah, pid } = await boot();
    let r = await post(`/api/projects/${pid}/allowance`, { included: 5 }, owner);
    expect(await json<Summary>(r)).toMatchObject({ entitlement: 5 });
    const [a] = (await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: sarah }))).map((p) => p.id);
    const sel = await json<{ summary: Summary }>(await api(`/api/projects/${pid}/selection`, { cookie: sarah }));
    await post(`/api/projects/${pid}/picks`, { photoId: a, picked: true, selectionVersion: sel.summary.selectionVersion }, sarah);
    expect((await post(`/api/projects/${pid}/cancel-round`, {}, owner)).status).toBe(200);
    expect((await json<{ picks: unknown[] }>(await api(`/api/projects/${pid}/selection`, { cookie: sarah }))).picks).toEqual([]);
    r = await post(`/api/projects/${pid}/allowance`, { included: -1 }, owner); expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/http/portal.test.ts` → FAIL (404s on new routes).

- [ ] **Step 3: Implement the routes**

`src/server/http/routes/selection.ts`:
```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../session.js';
import { loadProject, requireKind, isAdmin } from '../access.js';
import { setPick, summary, currentPicks, grantSlots, setIncluded, Conflict, SelectionError } from '../../domain/selection.js';
import { finishRound, cancelRound, requestExtras, TransitionError } from '../../domain/transitions.js';
import type { Config } from '../../config.js';

const Pick = z.object({ photoId: z.string().min(1), picked: z.boolean(), selectionVersion: z.number().int() });
const Finish = z.object({ selectionVersion: z.number().int() });
const Extras = z.object({ count: z.number().int().min(1).max(500) });
const Grant = z.object({ delta: z.number().int().min(-1000).max(1000), reason: z.enum(['gift', 'release']).default('gift') });
const Allowance = z.object({ included: z.number().int().min(0).max(100000) });

function fail(c: { json: (b: unknown, s: 409 | 422) => Response }, e: unknown): Response {
  if (e instanceof Conflict) return c.json({ error: 'conflict', selectionVersion: e.selectionVersion }, 409);
  if (e instanceof SelectionError || e instanceof TransitionError) return c.json({ error: e.code }, 422);
  throw e;
}
const parse = async <T,>(c: { req: { json: () => Promise<unknown> } }, s: z.ZodType<T>): Promise<T | null> => { const b = s.safeParse(await c.req.json().catch(() => null)); return b.success ? b.data : null; };

export const selectionRoutes = (config: Config, photosDir: string) => new Hono<AppEnv>()
  .get('/api/projects/:id/selection', loadProject(), (c) => {
    const db = c.get('db'); const p = c.get('project');
    return c.json({ summary: summary(db, p.id), picks: currentPicks(db, p.id) });
  })
  .post('/api/projects/:id/picks', loadProject(), async (c) => {
    const b = await parse(c, Pick); if (!b) return c.json({ error: 'invalid body' }, 400);
    const db = c.get('db'); const p = c.get('project'); const s = c.get('session')!;
    try { const sum = setPick(db, { projectId: p.id, photoId: b.photoId, picked: b.picked, byEmail: s.subject, expectedVersion: b.selectionVersion }); return c.json({ summary: sum, picks: currentPicks(db, p.id) }); }
    catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/finish', loadProject(), async (c) => {
    const b = await parse(c, Finish); if (!b) return c.json({ error: 'invalid body' }, 400);
    try { const r = await finishRound(c.get('db'), photosDir, { projectId: c.get('project').id, actor: c.get('session')!.subject, expectedVersion: b.selectionVersion, baseUrl: config.baseUrl }); return c.json({ round: r.round, count: r.photoIds.length }); }
    catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/extras-request', requireKind('client'), loadProject(), async (c) => {
    const b = await parse(c, Extras); if (!b) return c.json({ error: 'invalid body' }, 400);
    requestExtras(c.get('db'), { projectId: c.get('project').id, count: b.count, byEmail: c.get('session')!.subject, baseUrl: config.baseUrl });
    return c.json({ ok: true });
  })
  .post('/api/projects/:id/grant', requireKind('admin'), loadProject(), async (c) => {
    const b = await parse(c, Grant); if (!b) return c.json({ error: 'invalid body' }, 400);
    return c.json(await grantSlots(c.get('db'), photosDir, { projectId: c.get('project').id, delta: b.delta, reason: b.reason, actor: c.get('session')!.subject }));
  })
  .post('/api/projects/:id/allowance', requireKind('admin'), loadProject(), async (c) => {
    const b = await parse(c, Allowance); if (!b) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await setIncluded(c.get('db'), photosDir, { projectId: c.get('project').id, included: b.included, actor: c.get('session')!.subject })); }
    catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/cancel-round', requireKind('admin'), loadProject(), async (c) => {
    await cancelRound(c.get('db'), photosDir, { projectId: c.get('project').id, actor: c.get('session')!.subject });
    return c.json({ ok: true });
  });
export { isAdmin };
```
Remove the trailing `export { isAdmin };` and the `isAdmin` import once it compiles.

`src/server/http/routes/comments.ts`:
```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { loadPhoto, requireKind, isAdmin } from '../access.js';
import { addComment, listComments, resolveComment, CommentError } from '../../domain/comments.js';
import { comments } from '../../db/schema.js';

const Input = z.object({ text: z.string(), x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(), t: z.number().optional() });

export const commentRoutes = () => new Hono<AppEnv>()
  .get('/api/photos/:photoId/comments', loadPhoto(), (c) => c.json(listComments(c.get('db'), c.get('photo').id)))
  .post('/api/photos/:photoId/comments', loadPhoto(), async (c) => {
    const b = Input.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const db = c.get('db'); const s = c.get('session')!;
    try { return c.json(addComment(db, { photoId: c.get('photo').id, author: s.subject, isAdmin: isAdmin(db, s), input: b.data }), 201); }
    catch (e) { if (e instanceof CommentError) return c.json({ error: e.code }, 422); throw e; }
  })
  .post('/api/comments/:id/resolve', requireKind('admin'), async (c) => {
    const b = z.object({ resolved: z.boolean() }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const db = c.get('db');
    if (!db.select({ id: comments.id }).from(comments).where(eq(comments.id, c.req.param('id'))).get()) return c.json({ error: 'not found' }, 404);
    return c.json(resolveComment(db, { commentId: c.req.param('id'), actor: c.get('session')!.subject, resolved: b.data.resolved }));
  });
```

In `src/server/http/routes/projects.ts`, extend imports with `summary` from `../../domain/selection.js`, `commentCounts` from `../../domain/comments.js`, `picks, events` from the schema, and `isAdmin` (already imported). Add a module-level throttle map and replace the `/api/projects/:id` and `/api/projects/:id/photos` handlers:
```ts
// ponytail: per-process view throttle; one process per NAS.
const viewed = new Map<string, number>();
function recordView(db: Db, sessionId: string, projectId: string, actor: string) {
  const key = `${sessionId}:${projectId}`; const now = Date.now();
  if ((viewed.get(key) ?? 0) > now - 3600_000) return;
  viewed.set(key, now); db.insert(events).values({ projectId, actor, type: 'viewed', payload: {} }).run();
}
```
```ts
  .get('/api/projects/:id', loadProject(), (c) => {
    const db = c.get('db'); const p = c.get('project'); const s = c.get('session')!; const meta = ProjectJson.parse(p.metadataJson);
    if (s.kind !== 'admin') recordView(db, s.id, p.id, s.subject);
    const rows = db.select().from(photos).where(and(eq(photos.projectId, p.id), eq(photos.missing, false))).all();
    const submittedIds = new Set(db.select({ id: picks.photoId }).from(picks).where(and(eq(picks.projectId, p.id), lt(picks.round, p.currentRound))).all().map((r) => r.id));
    const done = rows.filter((r) => submittedIds.has(r.id) && r.editState === 'done').length;
    return c.json({ ...summaryOf(p), viewerEmail: s.subject, selection: summary(db, p.id), comments: meta.comments, progress: { done, total: submittedIds.size },
      counts: { culling: rows.filter((r) => r.stage === 'culling').length, final: rows.filter((r) => r.stage === 'final' && !r.draftRelPath).length, drafts: rows.filter((r) => r.draftRelPath).length } });
  })
  .get('/api/projects/:id/photos', loadProject(), (c) => {
    const db = c.get('db'); const p = c.get('project'); const admin = isAdmin(db, c.get('session'));
    const stage = (c.req.query('stage') ?? (['culling', 'editing'].includes(p.productionState) ? 'culling' : 'final')) as 'culling' | 'final';
    const pickBy = new Map(db.select().from(picks).where(eq(picks.projectId, p.id)).all().map((k) => [k.photoId, k]));
    const cc = commentCounts(db, p.id);
    const rows = db.select().from(photos).where(and(eq(photos.projectId, p.id), eq(photos.missing, false), eq(photos.stage, stage))).all()
      .filter((r) => admin || !r.draftRelPath)
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '') || a.relPath.localeCompare(b.relPath));
    return c.json(rows.map((r) => { const k = pickBy.get(r.id); return {
      id: r.id, relPath: r.relPath, stage: r.stage, kind: r.kind, width: r.width, height: r.height, section: r.section, hasDraft: !!r.draftRelPath, previewReady: r.width !== null,
      pick: k ? { state: k.state, byEmail: k.byEmail, locked: k.round < p.currentRound } : null, comments: cc[r.id] ?? { open: 0, total: 0 } }; }));
  })
```
Rename the existing `summary` helper in that file to `summaryOf` so it does not shadow the selection import; add `lt` to the drizzle import and `type Db` from `../../db/client.js`.

In `src/server/app.ts`, import `selectionRoutes` and `commentRoutes` and mount them after `projectRoutes`: `app.route('/', selectionRoutes(config, photosDir)); app.route('/', commentRoutes());`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run tests/http` → all pass, including the M1 `app.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/server/http src/server/app.ts tests/http/portal.test.ts
git commit -m "feat: portal api: selection, picks, finish, extras request, admin grants, comments"
```

---

### Task 6: Web — router, project home, culling grid, finish sheet

**Files:**
- Create: `src/web/router.ts`, `src/web/pages/ProjectHome.tsx`, `src/web/pages/Cull.tsx`, `src/web/components/Sheet.tsx`, `src/web/types.ts`
- Modify: `src/web/App.tsx`, `src/web/pages/Home.tsx` (list only; open navigates to `/p/:id`), `src/web/index.css`

**Interfaces:**
- `router.ts`: `useRoute(): { path: string; params: Record<string, string> }` matching `/`, `/p/:id`, `/p/:id/cull`; `navigate(path: string)` (pushState + event); back handled by `popstate`.
- `types.ts`: the JSON shapes from Task 5 (`ProjectDetail`, `PhotoItem`, `SelectionSummary`, `PickRow`, `CommentRow`).
- `Sheet.tsx`: `<Sheet open onClose title>` bottom sheet (fixed bottom, rounded top, safe-area padding, backdrop tap closes, 44pt targets).
- `Cull.tsx` exports `Cull({ id })` and owns: photos + selection state, `togglePick(photoId)` with optimistic update and 409 → refetch, filter All/Picked, density (2/3/4 columns via pinch or a segmented control fallback), bottom bar, extras request sheet, finish sheet; opens `Viewer` (Task 7) with `initialIndex`.

- [ ] **Step 1: Router and types**

`src/web/router.ts`:
```ts
import { useEffect, useState } from 'react';
const PATTERNS: [RegExp, string[]][] = [[/^\/$/, []], [/^\/p\/([^/]+)$/, ['id']], [/^\/p\/([^/]+)\/cull$/, ['id']], [/^\/setup$/, []], [/^\/signin$/, []]];
export function match(pathname: string) {
  for (const [re, names] of PATTERNS) { const m = pathname.match(re); if (m) return { path: re.source, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) }; }
  return { path: '404', params: {} };
}
export function navigate(path: string) { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }
export function useRoute() {
  const [r, setR] = useState(() => match(window.location.pathname));
  useEffect(() => { const on = () => setR(match(window.location.pathname)); window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on); }, []);
  return r;
}
```

`src/web/types.ts`:
```ts
export type SelectionSummary = { round: number; selectionVersion: number; included: number; entitlement: number; submitted: number; confirmed: number; pending: number; deficit: number; extraPrice: number };
export type ProjectDetail = { id: string; title: string; date: string | null; state: { booking: string; production: string; archivedAt: string | null }; viewerEmail: string; selection: SelectionSummary; comments: { culling: boolean; finals: boolean }; progress: { done: number; total: number }; counts: { culling: number; final: number; drafts: number } };
export type PhotoItem = { id: string; relPath: string; stage: 'culling' | 'final'; kind: 'photo' | 'video'; width: number | null; height: number | null; section: string | null; previewReady: boolean; pick: null | { state: 'confirmed' | 'pending'; byEmail: string; locked: boolean }; comments: { open: number; total: number } };
export type PickRow = { photoId: string; byEmail: string; state: 'confirmed' | 'pending'; round: number; locked: boolean };
export type CommentRow = { id: string; photoId: string; author: string; stage: string; x: number | null; y: number | null; w: number | null; h: number | null; t: number | null; text: string; createdAt: string; resolvedAt: string | null };
```

- [ ] **Step 2: Sheet, App, Home**

`src/web/components/Sheet.tsx`:
```tsx
import type { ReactNode } from 'react';
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl dark:bg-neutral-900">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        {title && <h2 className="text-lg font-semibold">{title}</h2>}
        <div className="mt-3">{children}</div>
      </div>
    </div>);
}
```

`src/web/App.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { api } from './api';
import { useRoute } from './router';
import { Setup } from './pages/Setup';
import { SignIn } from './pages/SignIn';
import { Home } from './pages/Home';
import { ProjectHome } from './pages/ProjectHome';
import { Cull } from './pages/Cull';

type Health = { setup: 'unconfigured' | 'awaiting_verification' | 'complete'; email: boolean };
export type Me = { kind: string; subject: string; isAdmin: boolean };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const route = useRoute();
  useEffect(() => { void api<Health>('/healthz').then(setHealth); void api<Me>('/api/me').then(setMe).catch(() => setMe(null)); }, []);
  if (!health || me === undefined) return null;
  if (route.path === '^\\/setup$' || health.setup !== 'complete') return <Setup state={health.setup} />;
  if (!me) return <SignIn />;
  if (route.path === '^\\/p\\/([^/]+)$') return <ProjectHome id={route.params.id!} me={me} />;
  if (route.path === '^\\/p\\/([^/]+)\\/cull$') return <Cull id={route.params.id!} me={me} />;
  return <Home me={me} />;
}
```

Replace `src/web/pages/Home.tsx` with a list that navigates:
```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import type { Me } from '../App';
type Project = { id: string; title: string; date: string | null; state: { production: string } };
const label: Record<string, string> = { not_started: 'Waiting for photos', shot: 'Waiting for photos', culling: 'Pick your favorites', editing: "We're editing", delivered: 'Your gallery is ready' };

export function Home({ me }: { me: Me }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  useEffect(() => { void api<Project[]>('/api/projects').then((ps) => { if (!me.isAdmin && ps.length === 1) navigate(`/p/${ps[0]!.id}`); else setProjects(ps); }); }, [me.isAdmin]);
  const signout = async () => { await api('/api/auth/signout', { method: 'POST' }); window.location.href = '/'; };
  if (!projects) return null;
  return (
    <main className="mx-auto max-w-2xl p-6">
      <header className="flex items-baseline justify-between"><h1 className="text-3xl font-semibold">{me.isAdmin ? 'Projects' : 'Your projects'}</h1><button onClick={signout} className="min-h-11 text-sm text-neutral-500">Sign out</button></header>
      <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
        {projects.map((p) => (<li key={p.id}><button onClick={() => navigate(`/p/${p.id}`)} className="flex min-h-11 w-full items-center justify-between py-4 text-left">
          <span><span className="block text-lg">{p.title}</span><span className="text-sm text-neutral-500">{p.date ?? 'No date'} · {label[p.state.production] ?? p.state.production}</span></span><span className="text-neutral-400">›</span></button></li>))}
        {projects.length === 0 && <li className="py-8 text-neutral-500">Nothing here yet.</li>}
      </ul>
    </main>);
}
```

- [ ] **Step 3: Project home**

`src/web/pages/ProjectHome.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import type { Me } from '../App';
import type { ProjectDetail } from '../types';

export function ProjectHome({ id, me }: { id: string; me: Me }) {
  const [p, setP] = useState<ProjectDetail | null>(null);
  useEffect(() => { void api<ProjectDetail>(`/api/projects/${id}`).then(setP).catch(() => navigate('/')); }, [id]);
  if (!p) return null;
  const s = p.selection; const picked = s.confirmed + s.pending;
  const status = (() => {
    switch (p.state.production) {
      case 'culling': return { line: `Pick your favorites · ${picked} of ${s.entitlement}`, cta: picked ? 'Continue' : 'Start picking', go: () => navigate(`/p/${id}/cull`) };
      case 'editing': return { line: `We're editing · ${p.progress.done} of ${p.progress.total} done`, cta: 'See your picks', go: () => navigate(`/p/${id}/cull`), bar: p.progress.total ? p.progress.done / p.progress.total : 0 };
      case 'delivered': return { line: 'Your gallery is ready', cta: 'Open gallery', go: () => navigate(`/p/${id}/cull`) };
      default: return { line: 'Your photos are on the way', cta: null, go: () => {} };
    }
  })();
  return (
    <main className="mx-auto max-w-2xl p-6">
      <button onClick={() => navigate('/')} className="min-h-11 text-blue-600">‹ {me.isAdmin ? 'Projects' : 'Your projects'}</button>
      <h1 className="mt-2 text-3xl font-semibold">{p.title}</h1>
      {p.date && <p className="text-neutral-500">{p.date}</p>}
      <section className="mt-8 rounded-2xl bg-neutral-100 p-5 dark:bg-neutral-900">
        <p className="text-lg">{status.line}</p>
        {status.bar !== undefined && <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-neutral-300 dark:bg-neutral-700"><div className="h-full bg-black dark:bg-white" style={{ width: `${Math.round(status.bar * 100)}%` }} /></div>}
        {status.cta && <button onClick={status.go} className="mt-4 min-h-11 w-full rounded-xl bg-black py-3 text-base font-medium text-white dark:bg-white dark:text-black">{status.cta}</button>}
      </section>
      <nav className="mt-8 divide-y divide-neutral-200 dark:divide-neutral-800">
        {['Documents', 'Share', 'Help'].map((t) => <div key={t} className="flex min-h-11 items-center justify-between py-3 text-neutral-400"><span>{t}</span><span className="text-xs">Coming soon</span></div>)}
      </nav>
    </main>);
}
```

- [ ] **Step 4: Culling grid**

`src/web/pages/Cull.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { navigate } from '../router';
import type { Me } from '../App';
import type { PhotoItem, ProjectDetail, SelectionSummary, PickRow } from '../types';
import { Sheet } from '../components/Sheet';
import { Viewer } from '../components/Viewer';

type SelResp = { summary: SelectionSummary; picks: PickRow[] };
const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

export function Cull({ id, me }: { id: string; me: Me }) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [sel, setSel] = useState<SelectionSummary | null>(null);
  const [filter, setFilter] = useState<'all' | 'picked'>('all');
  const [cols, setCols] = useState(3);
  const [open, setOpen] = useState<number | null>(null);
  const [sheet, setSheet] = useState<null | 'finish' | 'extras' | 'error'>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pinch = useRef<number | null>(null);

  const load = useCallback(async () => {
    const [p, ph, s] = await Promise.all([api<ProjectDetail>(`/api/projects/${id}`), api<PhotoItem[]>(`/api/projects/${id}/photos?stage=culling`), api<SelResp>(`/api/projects/${id}/selection`)]);
    setProject(p); setPhotos(ph); setSel(s.summary);
  }, [id]);
  useEffect(() => { void load().catch(() => navigate('/')); }, [load]);
  useEffect(() => { const on = () => { if (document.visibilityState === 'visible') void load(); }; document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on); }, [load]);

  const applyPicks = (ph: PhotoItem[], picks: PickRow[]) => { const m = new Map(picks.map((k) => [k.photoId, k])); return ph.map((x) => { const k = m.get(x.id); return { ...x, pick: k ? { state: k.state, byEmail: k.byEmail, locked: k.locked } : null }; }); };

  const togglePick = async (photoId: string) => {
    if (!sel || busy) return; const target = photos.find((p) => p.id === photoId); if (!target || target.pick?.locked) return;
    const picked = !target.pick;
    setPhotos((ps) => ps.map((p) => (p.id === photoId ? { ...p, pick: picked ? { state: 'pending', byEmail: me.subject, locked: false } : null } : p)));
    try {
      const r = await api<SelResp>(`/api/projects/${id}/picks`, { method: 'POST', body: JSON.stringify({ photoId, picked, selectionVersion: sel.selectionVersion }) });
      setSel(r.summary); setPhotos((ps) => applyPicks(ps, r.picks));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { await load(); return; }
      if (e instanceof ApiError && e.status === 422) { setError(e.message === 'not_culling' ? 'Picking is closed for this project.' : 'That photo can’t be picked.'); setSheet('error'); await load(); return; }
      throw e;
    }
  };

  const finish = async () => {
    if (!sel) return; setBusy(true);
    try { await api(`/api/projects/${id}/finish`, { method: 'POST', body: JSON.stringify({ selectionVersion: sel.selectionVersion }) }); setSheet(null); navigate(`/p/${id}`); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) { await load(); setSheet(null); return; }
      const msg: Record<string, string> = { pending_picks: 'Some picks are over your allowance. Remove them or ask for extras first.', no_picks: 'Pick at least one photo first.', unpaid_extras: 'Finish your extras purchase first.', needs_review: 'The studio is reviewing your account. Try again later.', deficit: 'The studio is reviewing your allowance. Try again later.' };
      setError(msg[(e as ApiError).message] ?? 'Could not finish right now.'); setSheet('error');
    } finally { setBusy(false); }
  };

  const requestExtras = async () => {
    if (!sel) return; setBusy(true);
    try { await api(`/api/projects/${id}/extras-request`, { method: 'POST', body: JSON.stringify({ count: sel.pending }) }); setError('Request sent. The studio will get back to you.'); setSheet('error'); }
    finally { setBusy(false); }
  };

  const onTouchStart = (e: React.TouchEvent) => { if (e.touches.length === 2) pinch.current = Math.hypot(e.touches[0]!.clientX - e.touches[1]!.clientX, e.touches[0]!.clientY - e.touches[1]!.clientY); };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length !== 2 || pinch.current === null) return;
    const d = Math.hypot(e.touches[0]!.clientX - e.touches[1]!.clientX, e.touches[0]!.clientY - e.touches[1]!.clientY);
    if (d > pinch.current * 1.3) { setCols((c) => Math.max(2, c - 1)); pinch.current = d; }
    if (d < pinch.current / 1.3) { setCols((c) => Math.min(5, c + 1)); pinch.current = d; }
  };

  if (!project || !sel) return null;
  const closed = project.state.production !== 'culling';
  const visible = filter === 'picked' ? photos.filter((p) => p.pick) : photos;
  const picked = sel.confirmed + sel.pending;
  const over = sel.pending > 0;
  const noPhotos = photos.length === 0 || photos.every((p) => !p.previewReady);

  return (
    <main className="pb-28" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={() => (pinch.current = null)}>
      <header className="sticky top-0 z-10 flex items-center justify-between bg-white/90 px-2 py-2 backdrop-blur dark:bg-black/80">
        <button onClick={() => navigate(`/p/${id}`)} className="min-h-11 px-2 text-blue-600">‹ {project.title}</button>
        <div className="flex rounded-lg bg-neutral-200 p-0.5 text-sm dark:bg-neutral-800" role="tablist">
          {(['all', 'picked'] as const).map((f) => <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={`min-h-9 rounded-md px-3 ${filter === f ? 'bg-white shadow dark:bg-neutral-600' : ''}`}>{f === 'all' ? 'All' : 'Picked'}</button>)}
        </div>
      </header>
      {noPhotos ? <p className="p-6 text-center text-neutral-500">{photos.length === 0 ? 'No photos yet. The studio will let you know when they’re up.' : 'Previews aren’t ready yet. Check back soon.'}</p> : (
        <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {visible.map((p, i) => (
            <button key={p.id} data-testid="tile" data-picked={p.pick ? p.pick.state : 'no'} onClick={() => setOpen(photos.indexOf(p))} className="relative aspect-square bg-neutral-200 dark:bg-neutral-800">
              {p.previewReady && <img src={`/api/photos/${p.id}/preview?size=thumb`} loading={i < 30 ? 'eager' : 'lazy'} className="h-full w-full object-cover" alt="" />}
              {p.kind === 'video' && <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-xs text-white">▶</span>}
              {p.comments.total > 0 && <span className="absolute left-1 bottom-1 rounded-full bg-black/60 px-1.5 text-xs text-white">{p.comments.total}</span>}
              <span onClick={(e) => { e.stopPropagation(); void togglePick(p.id); }} role="button" aria-label={p.pick ? 'Unpick' : 'Pick'} aria-pressed={!!p.pick}
                className={`absolute right-1 bottom-1 flex h-9 w-9 items-center justify-center rounded-full text-lg ${p.pick ? (p.pick.state === 'pending' ? 'bg-amber-400 text-black' : 'bg-white text-red-500') : 'bg-black/40 text-white'} ${p.pick?.locked ? 'opacity-70' : ''}`}>{p.pick ? '♥' : '♡'}</span>
            </button>))}
        </div>)}
      <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-neutral-200 bg-white/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur dark:border-neutral-800 dark:bg-black/90">
        {closed ? <p className="text-center text-neutral-500">{picked} picks sent · picking is closed</p> : over ? (
          <div className="flex items-center justify-between"><span>{sel.pending} extra photo{sel.pending > 1 ? 's' : ''} · {money(sel.pending * sel.extraPrice)}</span>
            <button onClick={() => setSheet('extras')} className="min-h-11 rounded-xl bg-black px-4 text-white dark:bg-white dark:text-black">Request</button></div>
        ) : (
          <div className="flex items-center justify-between"><span data-testid="count">{picked} of {sel.entitlement}</span>
            <button onClick={() => setSheet('finish')} disabled={picked === 0} className="min-h-11 rounded-xl bg-black px-4 text-white disabled:opacity-40 dark:bg-white dark:text-black">Finish</button></div>)}
      </footer>
      {open !== null && <Viewer photos={photos} index={open} projectId={id} me={me} commentsOn={project.comments.culling} onIndex={setOpen} onClose={() => setOpen(null)} onToggle={togglePick} onCommented={() => void load()} />}
      <Sheet open={sheet === 'finish'} onClose={() => setSheet(null)} title={`Send ${picked} pick${picked === 1 ? '' : 's'}?`}>
        <p className="text-neutral-600 dark:text-neutral-400">The studio will start editing these. You can still ask for extras later.</p>
        <button onClick={finish} disabled={busy} className="mt-4 min-h-11 w-full rounded-xl bg-black py-3 text-white disabled:opacity-40 dark:bg-white dark:text-black">Send picks</button>
      </Sheet>
      <Sheet open={sheet === 'extras'} onClose={() => setSheet(null)} title={`Ask for ${sel.pending} extra photo${sel.pending > 1 ? 's' : ''}?`}>
        <p className="text-neutral-600 dark:text-neutral-400">{money(sel.extraPrice)} each. The studio will confirm and send an invoice.</p>
        <button onClick={requestExtras} disabled={busy} className="mt-4 min-h-11 w-full rounded-xl bg-black py-3 text-white disabled:opacity-40 dark:bg-white dark:text-black">Send request</button>
      </Sheet>
      <Sheet open={sheet === 'error'} onClose={() => setSheet(null)}><p>{error}</p><button onClick={() => setSheet(null)} className="mt-4 min-h-11 w-full rounded-xl bg-neutral-200 py-3 dark:bg-neutral-800">OK</button></Sheet>
    </main>);
}
```
`Viewer` is defined in Task 7; until then create a stub `src/web/components/Viewer.tsx` exporting a component with the same props that renders `null`, so this task typechecks on its own.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npx vite build` → clean. Manually: `npm run build`, boot the server as in M1's Task 16, sign in as a client, open the project, pick photos, watch the counter and the extras bar, finish.

- [ ] **Step 6: Commit**

```bash
git add src/web
git commit -m "feat(web): router, project home, culling grid with shared picks, finish and extras sheets"
```

---

### Task 7: Web — viewer with swipe, heart, comments and region drawing

**Files:**
- Create: `src/web/components/Viewer.tsx` (replace the stub)

**Interfaces:**
- `Viewer({ photos, index, projectId, me, commentsOn, onIndex, onClose, onToggle, onCommented })`. Full-screen on black, image `object-contain`, swipe left/right changes index, swipe down closes, keyboard arrows/Escape on desktop. Heart bottom-right calls `onToggle(photo.id)`. Comment pins: numbered dots at region centers; tapping a pin shows the thread; long-press (500 ms) or mouse-drag on the image draws a region, then a text field anchored to the region posts `POST /api/photos/:id/comments`. Video: `<video controls playsInline>` from `/api/photos/:id/preview` is not available for video in M2 (posters arrive in M10), so show the poster placeholder and a timestamp field instead of a region. `commentsOn=false` hides the pin count and disables drawing.

- [ ] **Step 1: Implement**

`src/web/components/Viewer.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Me } from '../App';
import type { PhotoItem, CommentRow } from '../types';

type Region = { x: number; y: number; w: number; h: number };
type Props = { photos: PhotoItem[]; index: number; projectId: string; me: Me; commentsOn: boolean; onIndex: (i: number) => void; onClose: () => void; onToggle: (id: string) => void; onCommented: () => void };

export function Viewer({ photos, index, me, commentsOn, onIndex, onClose, onToggle, onCommented }: Props) {
  const photo = photos[index]!;
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [draft, setDraft] = useState<Region | null>(null);
  const [text, setText] = useState('');
  const [thread, setThread] = useState<CommentRow | null>(null);
  const [tsec, setTsec] = useState('');
  const img = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number; t: number; drawing: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => { setDraft(null); setThread(null); setText(''); if (commentsOn) void api<CommentRow[]>(`/api/photos/${photo.id}/comments`).then(setComments); else setComments([]); }, [photo.id, commentsOn]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'ArrowRight') onIndex(Math.min(photos.length - 1, index + 1)); if (e.key === 'ArrowLeft') onIndex(Math.max(0, index - 1)); if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on);
  }, [index, photos.length, onIndex, onClose]);

  const rel = (cx: number, cy: number): { x: number; y: number } | null => {
    const r = img.current?.getBoundingClientRect(); if (!r) return null;
    return { x: Math.min(1, Math.max(0, (cx - r.left) / r.width)), y: Math.min(1, Math.max(0, (cy - r.top) / r.height)) };
  };
  const canDraw = commentsOn && photo.kind === 'photo';

  const start = (cx: number, cy: number, immediate: boolean) => {
    const p = rel(cx, cy); if (!p) return;
    touch.current = { x: cx, y: cy, t: Date.now(), drawing: immediate };
    if (!immediate && canDraw) touch.current.timer = setTimeout(() => { if (touch.current) { touch.current.drawing = true; setDraft({ x: p.x, y: p.y, w: 0, h: 0 }); } }, 500);
    else if (immediate && canDraw) setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const move = (cx: number, cy: number) => {
    const t = touch.current; if (!t) return;
    if (!t.drawing) { if (Math.hypot(cx - t.x, cy - t.y) > 10 && t.timer) clearTimeout(t.timer); return; }
    const a = rel(t.x, t.y); const b = rel(cx, cy); if (!a || !b) return;
    setDraft({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  };
  const end = (cx: number, cy: number) => {
    const t = touch.current; touch.current = null; if (!t) return; if (t.timer) clearTimeout(t.timer);
    if (t.drawing) { if (draft && (draft.w < 0.02 || draft.h < 0.02)) setDraft(null); return; }
    const dx = cx - t.x, dy = cy - t.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) onIndex(dx < 0 ? Math.min(photos.length - 1, index + 1) : Math.max(0, index - 1));
    else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) onClose();
  };

  const post = async () => {
    const body: Record<string, unknown> = { text };
    if (photo.kind === 'photo' && draft) Object.assign(body, draft);
    if (photo.kind === 'video') body.t = Number(tsec) || 0;
    const c = await api<CommentRow>(`/api/photos/${photo.id}/comments`, { method: 'POST', body: JSON.stringify(body) });
    setComments((cs) => [...cs, c]); setDraft(null); setText(''); onCommented();
  };

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-black text-white" role="dialog" aria-modal="true">
      <div className="flex items-center justify-between p-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button onClick={onClose} className="min-h-11 px-3" aria-label="Close">✕</button>
        <span className="text-sm text-neutral-400">{index + 1} / {photos.length}</span>
        <span className="w-11" />
      </div>
      <div className="relative flex flex-1 items-center justify-center overflow-hidden select-none"
        onTouchStart={(e) => start(e.touches[0]!.clientX, e.touches[0]!.clientY, false)} onTouchMove={(e) => { if (touch.current?.drawing) e.preventDefault(); move(e.touches[0]!.clientX, e.touches[0]!.clientY); }} onTouchEnd={(e) => end(e.changedTouches[0]!.clientX, e.changedTouches[0]!.clientY)}
        onMouseDown={(e) => start(e.clientX, e.clientY, true)} onMouseMove={(e) => e.buttons === 1 && move(e.clientX, e.clientY)} onMouseUp={(e) => end(e.clientX, e.clientY)}>
        <div ref={img} className="relative max-h-full max-w-full">
          {photo.kind === 'photo' && photo.previewReady ? <img src={`/api/photos/${photo.id}/preview`} draggable={false} className="max-h-[calc(100vh-11rem)] max-w-full object-contain" alt="" />
            : <div className="flex h-64 w-64 items-center justify-center rounded bg-neutral-800 text-neutral-400">{photo.kind === 'video' ? 'Video' : 'Preview not ready'}</div>}
          {commentsOn && comments.map((c, i) => c.x !== null && (
            <button key={c.id} onClick={(e) => { e.stopPropagation(); setThread(c); }} style={{ left: `${(c.x + (c.w ?? 0) / 2) * 100}%`, top: `${(c.y! + (c.h ?? 0) / 2) * 100}%` }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 h-7 w-7 rounded-full border-2 border-white text-xs font-semibold ${c.resolvedAt ? 'bg-neutral-500/60' : 'bg-blue-500'}`} aria-label={`Comment ${i + 1}`}>{i + 1}</button>))}
          {draft && <div className="absolute border-2 border-yellow-300 bg-yellow-300/10" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }} />}
        </div>
      </div>
      <div className="flex items-center justify-between p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <span className="text-sm text-neutral-400">{commentsOn && comments.length > 0 ? `${comments.length} comment${comments.length > 1 ? 's' : ''}` : ''}{commentsOn && photo.kind === 'photo' && !draft ? ' · hold to draw' : ''}</span>
        <button onClick={() => onToggle(photo.id)} disabled={!!photo.pick?.locked} aria-pressed={!!photo.pick} aria-label={photo.pick ? 'Unpick' : 'Pick'}
          className={`flex h-12 w-12 items-center justify-center rounded-full text-2xl ${photo.pick ? (photo.pick.state === 'pending' ? 'bg-amber-400 text-black' : 'bg-white text-red-500') : 'bg-white/20'} disabled:opacity-60`}>{photo.pick ? '♥' : '♡'}</button>
      </div>
      {(draft && draft.w >= 0.02) || (commentsOn && photo.kind === 'video') ? (
        <form onSubmit={(e) => { e.preventDefault(); void post(); }} className="flex gap-2 bg-neutral-900 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {photo.kind === 'video' && <input inputMode="decimal" value={tsec} onChange={(e) => setTsec(e.target.value)} placeholder="0:00 as seconds" className="w-28 rounded-lg bg-neutral-800 px-3 py-2" />}
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note" className="min-h-11 flex-1 rounded-lg bg-neutral-800 px-3" data-testid="comment-input" />
          <button disabled={!text.trim()} className="min-h-11 rounded-lg bg-white px-4 text-black disabled:opacity-40">Post</button>
          {draft && <button type="button" onClick={() => setDraft(null)} className="min-h-11 px-2 text-neutral-400">Cancel</button>}
        </form>) : null}
      {thread && (
        <div className="absolute inset-x-3 bottom-24 rounded-xl bg-neutral-900 p-4 shadow-xl" role="dialog">
          <div className="flex items-start justify-between"><p className="text-sm text-neutral-400">{thread.author === me.subject ? 'You' : thread.author}{thread.resolvedAt ? ' · resolved' : ''}</p><button onClick={() => setThread(null)} className="min-h-8 px-2" aria-label="Close thread">✕</button></div>
          <p className="mt-1">{thread.text}</p>
        </div>)}
    </div>);
}
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npx vite build` → clean. Manually on a phone or in devtools device mode: open a photo, swipe, hold to draw a region, post a note, see the pin, tap the pin.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/Viewer.tsx
git commit -m "feat(web): full-screen viewer with swipe, heart, region comments and pins"
```

---

### Task 8: Playwright end-to-end on an iPhone viewport

**Files:**
- Create: `tests/e2e/server.ts`, `tests/e2e/culling.spec.ts`, `playwright.config.ts`
- Modify: `package.json` (devDependency `playwright`, scripts `test:e2e`), `.github/workflows/ci.yml` (e2e job), `.gitignore` (`test-results/`, `playwright-report/`)

**Interfaces:**
- `tests/e2e/server.ts` starts the real app in-process on a random port with a temp photos dir, memory mail transport, an in-process worker, seeds one client (`sarah@x.com`) with three RAWs and allowance 2, and exposes `{ baseUrl, mailbox(): Mail[], stop() }`; it serves `dist/web` so `npm run build` must run first (the script does it).

- [ ] **Step 1: Install and configure**

Run: `npm install -D playwright@latest && npx playwright install chromium`

`playwright.config.ts`:
```ts
import { defineConfig, devices } from 'playwright/test';
export default defineConfig({ testDir: 'tests/e2e', timeout: 60_000, use: { ...devices['iPhone 13'] }, reporter: 'list' });
```
Add scripts: `"test:e2e": "npm run build && playwright test"`. Add to `.gitignore`: `test-results/`, `playwright-report/`.

- [ ] **Step 2: Server harness**

`tests/e2e/server.ts`:
```ts
import { serve } from '@hono/node-server';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../../src/server/config.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createSetupToken, completeSetup, markSetupComplete } from '../../src/server/auth/bootstrap.js';
import { startWorker } from '../../src/server/jobs/worker.js';
import { makeEmailHandlers } from '../../src/server/email/send.js';
import { memoryTransport, type Mail } from '../../src/server/email/transport.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia, makePreviewHandlers } from '../../src/server/fs/photos.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';

export async function startTestServer() {
  const photosDir = await mkdtemp(join(tmpdir(), 'og-e2e-')); await mkdir(join(photosDir, 'Clients'), { recursive: true });
  const port = 3300 + Math.floor(Math.random() * 500); const baseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig({ DATA_DIR: photosDir, PHOTOS_DIR: photosDir, BASE_URL: baseUrl, SESSION_SECRET: 'x'.repeat(32) });
  const db = openDb(':memory:'); migrate(db);
  const mail = memoryTransport();
  const handlers = { ...makeEmailHandlers(() => mail, '127.0.0.1'), ...makePreviewHandlers(photosDir) };
  const token = createSetupToken(db);
  completeSetup(db, { token, ownerEmail: 'owner@x.com', studioName: 'E2E Studio', email: { type: 'smtp', url: 'smtp://u:p@h:587', from: 'S <s@x>' }, baseUrl });
  markSetupComplete(db);
  const c = defaultClientJson('Smith'); c.emails = ['sarah@x.com'];
  const p = defaultProjectJson('Wedding'); p.allowance = { included: 2, extraPrice: 1500, slots: 2 };
  await mkdir(join(photosDir, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await writeJsonAtomic(join(photosDir, 'Clients/Smith/client.json'), c);
  await writeJsonAtomic(join(photosDir, 'Clients/Smith/Wedding/project.json'), p);
  for (const [i, n] of ['a', 'b', 'c'].entries()) await sharp({ create: { width: 600, height: 400, channels: 3, background: ['#c33', '#3c3', '#33c'][i]! } }).tiff().toFile(join(photosDir, `Clients/Smith/Wedding/raw/${n}.dng`));
  await rescan(db, photosDir); await indexProjectMedia(db, photosDir, p.id!);
  while ((await runOnce(db, handlers)) === 'ran') { /* previews */ }
  const stopWorker = startWorker(db, handlers, { intervalMs: 200 });
  const server = serve({ fetch: createApp({ db, config, photosDir, webRoot: './dist/web' }).fetch, port });
  return { baseUrl, projectId: p.id!, mailbox: (): Mail[] => mail.sent, async stop() { stopWorker(); server.close(); await rm(photosDir, { recursive: true, force: true }); } };
}
```

- [ ] **Step 3: The flow**

`tests/e2e/culling.spec.ts`:
```ts
import { test, expect } from 'playwright/test';
import { startTestServer } from './server.js';

let srv: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => { srv = await startTestServer(); });
test.afterAll(async () => { await srv.stop(); });

test('client signs in, culls with a shared allowance, requests extras, and finishes', async ({ page }) => {
  await page.goto(srv.baseUrl + '/');
  await page.getByPlaceholder('you@example.com').fill('sarah@x.com');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByText(/sign-in link is on its way/)).toBeVisible();
  await expect.poll(() => srv.mailbox().length).toBe(1);
  const link = srv.mailbox()[0]!.text.match(/http:\/\/127\.0\.0\.1:\d+\/auth\/[A-Za-z0-9_-]+/)![0];
  await page.goto(link);
  // one project → lands on its home
  await expect(page.getByRole('heading', { name: 'Wedding' })).toBeVisible();
  await expect(page.getByText('Pick your favorites · 0 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Start picking' }).click();
  const tiles = page.getByTestId('tile');
  await expect(tiles).toHaveCount(3);
  await tiles.nth(0).getByRole('button', { name: 'Pick' }).click();
  await tiles.nth(1).getByRole('button', { name: 'Pick' }).click();
  await expect(page.getByTestId('count')).toHaveText('2 of 2');
  await tiles.nth(2).getByRole('button', { name: 'Pick' }).click();
  await expect(page.getByText('1 extra photo · $15')).toBeVisible();
  await page.getByRole('button', { name: 'Request' }).click();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Request sent.')).toBeVisible();
  await page.getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => srv.mailbox().some((m) => m.subject.includes('1 extra photos'))).toBe(true);
  // unpick the extra, open the viewer, comment, finish
  await tiles.nth(2).getByRole('button', { name: 'Unpick' }).click();
  await expect(page.getByTestId('count')).toHaveText('2 of 2');
  await tiles.nth(0).click();
  await expect(page.getByText('1 / 3')).toBeVisible();
  const img = page.locator('img[src*="/preview"]').first(); const box = (await img.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 }); await page.mouse.up();
  await page.getByTestId('comment-input').fill('soften the shadow');
  await page.getByRole('button', { name: 'Post' }).click();
  await expect(page.getByRole('button', { name: 'Comment 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('heading', { name: 'Send 2 picks?' })).toBeVisible();
  await page.getByRole('button', { name: 'Send picks' }).click();
  await expect(page.getByText("We're editing · 0 of 2 done")).toBeVisible();
  await expect.poll(() => srv.mailbox().some((m) => m.subject.includes('finished picking'))).toBe(true);
});
```

- [ ] **Step 4: Run**

Run: `npm run test:e2e` → 1 passed. If the region drag fails to register because Playwright's iPhone emulation converts mouse to touch, switch the drawing steps to `page.touchscreen.tap` + a `dispatchEvent` sequence, or keep `hasTouch: false` in the config's `use` for this project (the desktop-mouse path is the one exercised; touch drawing is verified by hand).

- [ ] **Step 5: CI job**

Append to `.github/workflows/ci.yml` under `jobs`:
```yaml
  e2e:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: sudo apt-get update && sudo apt-get install -y libimage-exiftool-perl
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
```

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts tests/e2e package.json package-lock.json .github/workflows/ci.yml .gitignore
git commit -m "test: playwright culling flow on an iPhone viewport against an in-process server"
```

---

### Task 9: Milestone gate — rounds, extras math, workflow cases

**Files:**
- Create: `docs/gates/m2-culling.md`

- [ ] **Step 1: Automated evidence**

Run: `npm run typecheck && npm test && npm run test:e2e` → green. Map to spec §18:
- **Rounds:** `tests/domain/transitions.test.ts` (finish 2 of 40; zero picks rejected with `no_picks`; finish under allowance moves to editing), `tests/http/portal.test.ts` (locked picks after finish return 422). "Finish with fewer usable photos than allowance" is the same case (allowance 40, two photos).
- **Extras (without payment):** `tests/domain/selection.test.ts` (two emails pick the same photo once; picks confirmed in `picked_at` order; overflow pending; grant promotes; negative grant demotes; deficit only against submitted; stale version conflicts), `tests/http/portal.test.ts` (409 carries the current version; grant via admin route; request emails once).
- **Workflow (culling cases):** `tests/domain/transitions.test.ts` (later RAW never regresses `editing`; guards for pending/unpaid/review/not-culling; `stateVersion` increments per transition and projects to disk).
- **Comments:** `tests/domain/comments.test.ts`, `tests/http/portal.test.ts`.
- **End-to-end:** `tests/e2e/culling.spec.ts`.

- [ ] **Step 2: Manual checks on a phone**

With `npm run build` and the server running on the LAN, on an actual iPhone in Safari: sign in from the emailed link, Add to Home Screen, open the project, pinch the grid between 2 and 5 columns, pick above the allowance and see the amber pending hearts and the extras bar, long-press a photo to draw a region and post a note, swipe between photos, swipe down to close, finish. Note anything that fails.

- [ ] **Step 3: Write the record and commit**

`docs/gates/m2-culling.md`: date, commit, test counts, the mapping above, the manual phone results, and the deviations: `selectionVersion` instead of `stateVersion` for pick concurrency; video posters and playback deferred to M10 (video tiles show a placeholder and take timestamp comments); pull-to-refresh replaced by refresh-on-visibility.

```bash
git add docs/gates/m2-culling.md
git commit -m "docs: milestone 2 gate record"
git tag m2-culling
```

---

## Self-review notes

- **Spec coverage (M2 line of §21):** sign-in (M1, reused; single-project redirect in Task 6), culling grid (Task 6), viewer (Task 7), shared selection with slots (Task 2), finish under allowance (Task 3), comments (Tasks 4, 5, 7), project home (Task 6). Local mode: extras request (Tasks 3, 5, 6). Gates rounds and extras math (Task 9). Ingest → culling transition from §10 (Task 3) is required for the portal to be reachable, so it is in scope.
- **Deferred within §6 to later milestones, by the spec's own build order:** final gallery, guests, offers, additional rounds, forms, expiry, editing progress badges beyond the bar (M5, M6, M8, M9), video posters (M10), Stripe extras checkout (M7), admin UI for grants and allowance (M3; the routes exist now so tests and the MCP can use them).
- **Type consistency:** `SelectionSummary` is defined once in `domain/selection.ts` and mirrored in `web/types.ts`; routes return exactly that shape. `PhotoItem.pick` is `null | { state, byEmail, locked }` in both the route and the web type. `Viewer` props match the call in `Cull.tsx`. `finishRound` returns `{ round, photoIds }`; the route maps it to `{ round, count }`, which the test and the web expect.
