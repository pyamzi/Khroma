import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { checkTenancy } from '../src/server/db/check.js';
import { testDb } from './helpers.js';

describe('checkTenancy', () => {
  it('passes on a migrated database and leaves nothing behind', async () => {
    const db = await testDb();
    expect(await checkTenancy(db)).toEqual([]);
    const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from studios`);
    expect(('rows' in res ? res.rows : res)[0]!.n).toBe(0);
  });
  it('names a table whose row-level security was switched off', async () => {
    const db = await testDb();
    await db.execute(sql`alter table clients no force row level security`);
    expect(await checkTenancy(db)).toEqual([expect.stringMatching(/clients.*forced/)]);
  });
  it('fails when a Studio can read another Studio\'s rows', async () => {
    const db = await testDb();
    await db.execute(sql`drop policy tenant on clients`);
    await db.execute(sql`create policy tenant on clients using (true) with check (true)`);
    expect((await checkTenancy(db)).join('\n')).toMatch(/can see another Studio/);
  });
});
