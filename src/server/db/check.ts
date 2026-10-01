import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './client.js';
import { withStudio, asSystem } from './tenancy.js';
import { newId } from '../ids.js';

class Rollback extends Error {}
const rows = async <T>(db: Db, q: SQL): Promise<T[]> => { const r: unknown = await db.execute(q); return (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[]; }; // node-postgres and PGlite shape results differently

/** Deploy gate: returns what is wrong with tenant isolation on this database; empty means sound. Writes nothing that survives. */
export async function checkTenancy(db: Db): Promise<string[]> {
  const out: string[] = [];
  for (const name of ['og_app', 'og_system']) {
    const [role] = await rows<{ su: boolean; by: boolean }>(db, sql`select rolsuper as su, rolbypassrls as by from pg_roles where rolname = ${name}`);
    if (!role) { out.push(`role ${name} does not exist`); continue; }
    if (role.su) out.push(`${name} is a superuser`);
    if (role.by) out.push(`${name} can bypass row-level security`);
  }
  if (out.length) return out;
  const [app] = await withStudio(db, 'check', (tx) => rows<{ u: string }>(tx, sql`select current_user as u`));
  if (app?.u !== 'og_app') out.push(`Studio transactions run as ${app?.u}, not og_app`);
  const [sys] = await asSystem(db, (tx) => rows<{ u: string }>(tx, sql`select current_user as u`));
  if (sys?.u !== 'og_system') out.push(`system transactions run as ${sys?.u}, not og_system`);
  for (const t of await rows<{ t: string; rls: boolean; forced: boolean; policies: number; indexed: boolean }>(db, sql`
    select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced, (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies,
      (c.relname = 'studios' or exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0] where i.indrelid = c.oid and a.attname = 'studio_id')) as indexed
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname not like 'auth\\_%' /* auth_* has studio_id but is not a tenant table; the privilege check below covers it */ and (c.relname = 'studios' or exists (
      select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'studio_id'))`)) {
    if (!t.rls) out.push(`${t.t}: row-level security not enabled`);
    if (!t.forced) out.push(`${t.t}: row-level security not forced`);
    if (t.policies === 0) out.push(`${t.t}: no policy`);
    if (!t.indexed) out.push(`${t.t}: no index led by studio_id`);
  }
  for (const t of await rows<{ t: string; app: boolean; sys: boolean }>(db, sql`
    select c.relname as t, has_table_privilege('og_app', c.oid, 'SELECT') as app, has_table_privilege('og_system', c.oid, 'SELECT') as sys
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'auth\\_%'`)) {
    if (t.app) out.push(`og_app can read ${t.t}`);
    if (t.sys) out.push(`og_system can read ${t.t}`);
  }
  const a = `check-${newId()}`; const b = `check-${newId()}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local role og_system`);
    await tx.execute(sql`insert into studios (id, name) values (${a}, 'check A'), (${b}, 'check B')`);
    await tx.execute(sql`insert into clients (id, studio_id, name, emails) values (${`${a}-c`}, ${a}, 'A', '[]'), (${`${b}-c`}, ${b}, 'B', '[]')`);
    await tx.execute(sql`set local role og_app`);
    for (const [me, other] of [[a, b], [b, a]] as const) {
      await tx.execute(sql`select set_config('app.studio_id', ${me}, true)`);
      if ((await rows<{ id: string }>(tx as unknown as Db, sql`select id from clients where studio_id = ${other}`)).length) out.push(`a Studio can see another Studio's clients`);
    }
    throw new Rollback();
  }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
  return [...new Set(out)];
}
