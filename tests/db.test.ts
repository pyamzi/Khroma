import { describe, it, expect } from 'vitest';
import { invoices, projects, clients, jobs, authUsers } from '../src/server/db/schema.js';
import { getSetting, setSetting } from '../src/server/db/settings.js';
import { withStudio, asSystem } from '../src/server/db/tenancy.js';
import { join } from 'node:path';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { openDb, migrationsFolder } from '../src/server/db/client.js';
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
  it('migration 0003 retires H1 people sessions and keeps plugin tokens', async () => {
    const before = await tmpDir(); await cp(migrationsFolder, before, { recursive: true }); // the schema as H1 left it
    const journal = JSON.parse(await readFile(join(before, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    const last = journal.entries.pop()!; expect(last.tag).toBe('0003_retire_h1_sessions');
    await writeFile(join(before, 'meta/_journal.json'), JSON.stringify(journal)); await rm(join(before, `${last.tag}.sql`));
    const pg = new PGlite(); const db = drizzle(pg);
    try {
      await migrate(db, { migrationsFolder: before });
      await pg.exec(`insert into studios (id, name) values ('s', 'S');
        insert into sessions (id, studio_id, kind, subject, login_token_hash, token_hash, expires_at) values
          ('a', 's', 'admin', 'o@x', 'l1', 't1', '2999-01-01'), ('c', 's', 'client', 'c@x', null, 't2', '2999-01-01'), ('p', 's', 'plugin', 'o@x', null, 't3', '2999-01-01');`);
      await migrate(db, { migrationsFolder });
      expect((await pg.query<{ id: string; kind: string }>('select id, kind from sessions')).rows).toEqual([{ id: 'p', kind: 'plugin' }]);
      expect((await pg.query(`select 1 from information_schema.columns where table_name = 'sessions' and column_name in ('login_token_hash', 'redeemed_at')`)).rows).toEqual([]);
    } finally { await pg.close(); }
  });
});
