import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './client.js';
import { withStudio } from './tenancy.js';
import { newId } from '../ids.js';

class Rollback extends Error {}
const rows = async <T>(db: Db, q: SQL): Promise<T[]> => { const r: unknown = await db.execute(q); return (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[]; }; // node-postgres and PGlite shape results differently

/** Deploy gate: returns what is wrong with tenant isolation on this database; empty means sound. Writes nothing that survives. */
export async function checkTenancy(db: Db): Promise<string[]> {
  const out: string[] = [];
  const [role] = await rows<{ su: boolean; by: boolean }>(db, sql`select rolsuper as su, rolbypassrls as by from pg_roles where rolname = 'og_app'`);
  if (!role) return ['role og_app does not exist'];
  if (role.su) out.push('og_app is a superuser');
  if (role.by) out.push('og_app can bypass row-level security');
  const [who] = await withStudio(db, 'check', (tx) => rows<{ u: string }>(tx, sql`select current_user as u`));
  if (who?.u !== 'og_app') out.push(`app transactions run as ${who?.u}, not og_app`);
  for (const t of await rows<{ t: string; rls: boolean; forced: boolean; policies: number }>(db, sql`
    select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced, (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and (c.relname = 'studios' or exists (
      select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'studio_id'))`)) {
    if (!t.rls) out.push(`${t.t}: row-level security not enabled`);
    if (!t.forced) out.push(`${t.t}: row-level security not forced`);
    if (t.policies === 0) out.push(`${t.t}: no policy`);
  }
  const a = `check-${newId()}`; const b = `check-${newId()}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local role og_app`);
    await tx.execute(sql`select set_config('app.system', 'on', true)`);
    await tx.execute(sql`insert into studios (id, name) values (${a}, 'check A'), (${b}, 'check B')`);
    await tx.execute(sql`insert into clients (id, studio_id, name, emails) values (${`${a}-c`}, ${a}, 'A', '[]'), (${`${b}-c`}, ${b}, 'B', '[]')`);
    await tx.execute(sql`select set_config('app.system', '', true)`);
    for (const [me, other] of [[a, b], [b, a]] as const) {
      await tx.execute(sql`select set_config('app.studio_id', ${me}, true)`);
      const seen = await rows<{ id: string }>(tx as unknown as Db, sql`select id from clients where studio_id = ${other}`);
      if (seen.length) out.push(`a Studio can see another Studio's clients`);
    }
    throw new Rollback();
  }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
  return [...new Set(out)];
}
