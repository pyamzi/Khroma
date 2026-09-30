import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { clients, projects } from '../src/server/db/schema.js';
import { makePool, type Db } from '../src/server/db/client.js';
import { withStudio, asSystem, anonTx } from '../src/server/db/tenancy.js';
import { testDb, makeStudio, pgFail } from './helpers.js';

describe('tenant isolation', () => {
  it('each Studio sees and changes only its own rows', async () => {
    const db = await testDb(); const a = await makeStudio(db, { ownerEmail: 'a@x.com' }); const b = await makeStudio(db, { ownerEmail: 'b@x.com' });
    await withStudio(db, a.studioId, (tx) => tx.insert(clients).values({ id: 'ca', name: 'A client', emails: ['c@x.com'] }));
    expect(await withStudio(db, b.studioId, (tx) => tx.select().from(clients))).toEqual([]);
    expect(await withStudio(db, b.studioId, (tx) => tx.update(clients).set({ name: 'hacked' }).where(eq(clients.id, 'ca')).returning({ id: clients.id }))).toEqual([]);
    expect(await pgFail(withStudio(db, b.studioId, (tx) => tx.insert(clients).values({ id: 'x', studioId: a.studioId, name: 'n', emails: [] })))).toMatch(/row-level security/);
    expect((await withStudio(db, a.studioId, (tx) => tx.select().from(clients))).map((c) => c.name)).toEqual(['A client']);
  });
  it('no Studio set: reads nothing, cannot insert', async () => {
    const db = await testDb(); const a = await makeStudio(db);
    await withStudio(db, a.studioId, (tx) => tx.insert(clients).values({ id: 'ca', name: 'A', emails: [] }));
    expect(await anonTx(db, (tx) => tx.select().from(clients))).toEqual([]);
    await expect(anonTx(db, (tx) => tx.insert(clients).values({ id: 'y', name: 'n', emails: [] }))).rejects.toThrow();
  });
  it('the Studio setting ends with the transaction', async () => {
    const db = await testDb(); const a = await makeStudio(db);
    await withStudio(db, a.studioId, (tx) => tx.insert(clients).values({ id: 'ca', name: 'A', emails: [] }));
    expect(await anonTx(db, (tx) => tx.select().from(clients))).toEqual([]);
  });
  it('asSystem sees every Studio', async () => {
    const db = await testDb(); const a = await makeStudio(db); const b = await makeStudio(db);
    await withStudio(db, a.studioId, (tx) => tx.insert(clients).values({ id: 'ca', name: 'A', emails: [] }));
    await withStudio(db, b.studioId, (tx) => tx.insert(clients).values({ id: 'cb', name: 'B', emails: [] }));
    expect((await asSystem(db, (tx) => tx.select().from(clients))).length).toBe(2);
  });
  it('every table with a studio_id column has forced RLS and a policy; studios too', async () => {
    const db = await testDb();
    const rows = await asSystem(db, (tx) => tx.execute<{ relname: string; rls: boolean; forced: boolean; policies: number }>(sql`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and (c.relname = 'studios' or exists (
        select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'studio_id'))`));
    const list = 'rows' in rows ? rows.rows : rows;
    expect(list.length).toBeGreaterThanOrEqual(14);
    for (const r of list) expect({ t: r.relname, rls: r.rls, forced: r.forced, policy: r.policies > 0 }).toEqual({ t: r.relname, rls: true, forced: true, policy: true });
  });
  it('app transactions run as og_app, which cannot bypass RLS', async () => {
    const db = await testDb(); const a = await makeStudio(db);
    for (const run of [<T>(f: (tx: typeof db) => Promise<T>) => withStudio(db, a.studioId, f), <T>(f: (tx: typeof db) => Promise<T>) => anonTx(db, f)]) {
      const res = await run((tx) => tx.execute<{ u: string; su: boolean; by: boolean }>(sql`select current_user as u, r.rolsuper as su, r.rolbypassrls as by from pg_roles r where r.rolname = 'og_app'`));
      const [r] = 'rows' in res ? res.rows : res;
      expect(r).toEqual({ u: 'og_app', su: false, by: false });
    }
  });
});

describe('tenancy hardening (final review)', () => {
  const list = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
  it('system transactions run as og_system, which cannot bypass RLS either', async () => {
    const db = await testDb();
    const [r] = list<{ u: string; su: boolean; by: boolean }>(await asSystem(db, (tx) => tx.execute(sql`select current_user as u, r.rolsuper as su, r.rolbypassrls as by from pg_roles r where r.rolname = current_user`)));
    expect(r).toEqual({ u: 'og_system', su: false, by: false });
  });
  it('every tenant table has an index led by studio_id', async () => {
    const db = await testDb();
    const missing = list<{ t: string }>(await asSystem(db, (tx) => tx.execute(sql`
      select k.table_name as t from information_schema.columns k where k.table_schema = 'public' and k.column_name = 'studio_id'
      and not exists (select 1 from pg_index i join pg_class c on c.oid = i.indrelid join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
        where c.relname = k.table_name and a.attname = 'studio_id')`)));
    expect(missing).toEqual([]);
  });
  it('a Studio-scoped read can use the studio_id index', async () => {
    const db = await testDb(); const a = await makeStudio(db);
    const plan = await withStudio(db, a.studioId, async (tx) => { await tx.execute(sql`set local enable_seqscan = off`); return list<{ 'QUERY PLAN': string }>(await tx.execute(sql`explain select * from clients`)).map((x) => x['QUERY PLAN']).join('\n'); });
    expect(plan).not.toMatch(/Seq Scan/);
  });
  it('a row cannot reference another Studio\'s row', async () => {
    const db = await testDb(); const a = await makeStudio(db); const b = await makeStudio(db);
    await withStudio(db, a.studioId, (tx) => tx.insert(clients).values({ id: 'ca', name: 'A', emails: [] }));
    expect(await pgFail(withStudio(db, b.studioId, (tx) => tx.insert(projects).values({ id: 'pb', clientId: 'ca', metadataJson: {} })))).toMatch(/foreign key/);
  });
  it('transactions carry statement and idle timeouts', async () => {
    const db = await testDb(); const a = await makeStudio(db);
    for (const run of [(f: (tx: Db) => Promise<unknown>) => withStudio(db, a.studioId, f), (f: (tx: Db) => Promise<unknown>) => asSystem(db, f), (f: (tx: Db) => Promise<unknown>) => anonTx(db, f)]) {
      const [r] = list<{ s: string; i: string }>(await run((tx) => tx.execute(sql`select current_setting('statement_timeout') as s, current_setting('idle_in_transaction_session_timeout') as i`)));
      expect(r).toEqual({ s: '30s', i: '1min' });
    }
  });
  it('a dropped idle pool connection does not crash the process', async () => {
    const pool = makePool('postgres://u:p@127.0.0.1:1/db');
    expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
    await pool.end();
  });
});
