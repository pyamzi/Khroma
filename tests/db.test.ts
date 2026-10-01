import { describe, it, expect } from 'vitest';
import { invoices, projects, clients, jobs, authUsers } from '../src/server/db/schema.js';
import { getSetting, setSetting } from '../src/server/db/settings.js';
import { withStudio, asSystem } from '../src/server/db/tenancy.js';
import { join } from 'node:path';
import { openDb } from '../src/server/db/client.js';
import { checkTenancy } from '../src/server/db/check.js';
import { testDb, makeStudio, pgFail, tmpDir } from './helpers.js';
import { pgCode } from '../src/server/db/errors.js';

describe('database', () => {
  it('allows only one unpaid extras invoice per project', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db);
    await withStudio(db, studioId, async (tx) => {
      await tx.insert(clients).values({ id: 'c1', name: 'A', emails: ['a@x'] });
      await tx.insert(projects).values({ id: 'p1', clientId: 'c1', metadataJson: {} });
    });
    const row = { projectId: 'p1', kind: 'extras' as const, amount: 100, tax: 0, currency: 'usd' };
    await withStudio(db, studioId, (tx) => tx.insert(invoices).values({ id: 'i1', ...row }));
    expect(await pgFail(withStudio(db, studioId, (tx) => tx.insert(invoices).values({ id: 'i2', ...row })))).toMatch(/duplicate key/);
    await withStudio(db, studioId, (tx) => tx.insert(invoices).values({ id: 'i3', ...row, paidAt: new Date().toISOString(), paidAmount: 100 }));
  });
  it('rejects duplicate job idempotency keys within a Studio, allows them across Studios', async () => {
    const db = await testDb(); const a = await makeStudio(db); const b = await makeStudio(db);
    await withStudio(db, a.studioId, (tx) => tx.insert(jobs).values({ id: 'j1', kind: 'x', payload: {}, idempotencyKey: 'k', nextAt: 0 }));
    const err = await withStudio(db, a.studioId, (tx) => tx.insert(jobs).values({ id: 'j2', kind: 'x', payload: {}, idempotencyKey: 'k', nextAt: 0 })).catch((e: unknown) => e);
    expect(pgCode(err)).toBe('23505');
    await withStudio(db, b.studioId, (tx) => tx.insert(jobs).values({ id: 'j3', kind: 'x', payload: {}, idempotencyKey: 'k', nextAt: 0 }));
  });
  it('denies Studio and system transactions every auth table', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db);
    expect(await pgFail(withStudio(db, studioId, (tx) => tx.select().from(authUsers)))).toMatch(/permission denied/);
    expect(await pgFail(asSystem(db, (tx) => tx.select().from(authUsers)))).toMatch(/permission denied/);
  });
  it('rejects a project whose client does not exist', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db);
    expect(await pgFail(withStudio(db, studioId, (tx) => tx.insert(projects).values({ id: 'p1', clientId: 'ghost', metadataJson: {} })))).toMatch(/foreign key/);
  });
  it('stores epoch-ms job times exactly', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db); const now = Date.now();
    await withStudio(db, studioId, (tx) => tx.insert(jobs).values({ id: 'j1', kind: 'x', payload: {}, nextAt: now, leasedUntil: now + 1 }));
    const [j] = await withStudio(db, studioId, (tx) => tx.select().from(jobs));
    expect([j!.nextAt, j!.leasedUntil]).toEqual([now, now + 1]);
    expect(j!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
  it('stores settings per Studio', async () => {
    const db = await testDb(); const a = await makeStudio(db); const b = await makeStudio(db);
    await withStudio(db, a.studioId, (tx) => setSetting(tx, 'studio', { tz: 'America/Chicago' }));
    await withStudio(db, a.studioId, (tx) => setSetting(tx, 'studio', { tz: 'UTC' }));
    expect(await withStudio(db, a.studioId, (tx) => getSetting(tx, 'studio'))).toEqual({ tz: 'UTC' });
    expect(await withStudio(db, b.studioId, (tx) => getSetting(tx, 'studio'))).toBeNull();
    expect(await withStudio(db, a.studioId, (tx) => getSetting(tx, 'missing'))).toBeNull();
  });
  it('opens an on-disk PGlite database in a directory that does not exist yet', async () => {
    const { db, close } = await openDb(`pglite://${join(await tmpDir(), '.data', 'dev')}`, { migrate: true });
    try { expect(await checkTenancy(db)).toEqual([]); } finally { await close(); }
  });
});
