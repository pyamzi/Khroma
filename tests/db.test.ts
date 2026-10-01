import { describe, it, expect } from 'vitest';
import { invoices, projects, clients, jobs, authUsers, photos } from '../src/server/db/schema.js';
import { getSetting, setSetting } from '../src/server/db/settings.js';
import { withStudio, asSystem } from '../src/server/db/tenancy.js';
import { join } from 'node:path';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { openDb, migrationsFolder } from '../src/server/db/client.js';
import { checkTenancy } from '../src/server/db/check.js';
import { testDb, makeStudio, studioTestDb, pgFail, tmpDir } from './helpers.js';
import { pgCode } from '../src/server/db/errors.js';

describe('database', () => {
  it('a Library photo needs no project and defaults to in_library ready', async () => {
    const { db } = await studioTestDb();
    await db.insert(photos).values({ id: 'p1', projectId: null, relPath: 'library/p1/a.jpg', stage: 'final', kind: 'photo', checksum: '' });
    const [r] = await db.select().from(photos);
    expect(r).toMatchObject({ projectId: null, inLibrary: true, status: 'ready', keywords: [], caption: null, readyAt: null, purgedAt: null });
    expect(r!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
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
    for (const tag of ['0005_favorites_viewer', '0004_library', '0003_retire_h1_sessions']) { // roll the copy back to before 0003
      expect(journal.entries.pop()!.tag).toBe(tag); await rm(join(before, `${tag}.sql`));
    }
    await writeFile(join(before, 'meta/_journal.json'), JSON.stringify(journal));
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
  it('migration 0004 takes culling RAWs and unpublished drafts out of the Library and leaves live finals in', async () => {
    const before = await tmpDir(); await cp(migrationsFolder, before, { recursive: true });
    const journal = JSON.parse(await readFile(join(before, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    for (const tag of ['0005_favorites_viewer', '0004_library']) { expect(journal.entries.pop()!.tag).toBe(tag); await rm(join(before, `${tag}.sql`)); }
    await writeFile(join(before, 'meta/_journal.json'), JSON.stringify(journal));
    const pg = new PGlite(); const db = drizzle(pg);
    try {
      await migrate(db, { migrationsFolder: before });
      await pg.exec(`insert into studios (id, name) values ('s', 'S');
        insert into clients (id, studio_id, name, emails) values ('c', 's', 'C', '[]');
        insert into projects (id, studio_id, client_id, metadata_json) values ('p', 's', 'c', '{}');
        insert into photos (id, studio_id, project_id, rel_path, stage, kind, checksum) values
          ('raw', 's', 'p', 'raw/a.dng', 'culling', 'photo', ''), ('fin', 's', 'p', 'finals/a.jpg', 'final', 'photo', '');
        insert into photos (id, studio_id, project_id, rel_path, draft_rel_path, live, stage, kind, checksum) values
          ('draft', 's', 'p', 'finals/b.jpg', 'finals/.draft/b.jpg', false, 'final', 'photo', ''), ('livedraft', 's', 'p', 'finals/c.jpg', 'finals/.draft/c.jpg', true, 'final', 'photo', '');`);
      // an owner with no BYPASSRLS and no inherited policy roles (as on Neon): policies exist only for og_app and og_system, so a plain owner UPDATE would match nothing
      await pg.exec(`create role mig login noinherit; grant create on database postgres to mig; grant og_app, og_system to mig; grant all on schema public, drizzle to mig; grant all on all tables in schema drizzle to mig; grant all on all sequences in schema drizzle to mig;
        do $$ declare t text; begin for t in select tablename from pg_tables where schemaname = 'public' loop execute format('alter table %I owner to mig', t); end loop; end $$; set role mig;`);
      await migrate(db, { migrationsFolder });
      await pg.exec('reset role');
      expect((await pg.query<{ id: string; in_library: boolean }>('select id, in_library from photos order by id')).rows).toEqual([{ id: 'draft', in_library: false }, { id: 'fin', in_library: true }, { id: 'livedraft', in_library: true }, { id: 'raw', in_library: false }]);
    } finally { await pg.close(); }
  });
});
