import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, onTestFinished } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../src/server/db/schema.js';
import { migrationsFolder, type Db } from '../src/server/db/client.js';
import { asSystem } from '../src/server/db/tenancy.js';
import { newId } from '../src/server/ids.js';
import { pgMessage } from '../src/server/db/errors.js';

const created: string[] = [];
export async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'og-'));
  created.push(d);
  return d;
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

let template: Promise<PGlite> | undefined; // one migrated database per test worker, cloned per test (~90 ms)
/** A fresh migrated database. Inside a test it closes when the test ends. */
export async function testDb(): Promise<Db> {
  template ??= (async () => { const pg = new PGlite(); await migrate(drizzle(pg), { migrationsFolder }); return pg; })();
  const pg = await (await template).clone();
  try { onTestFinished(() => pg.close()); } catch { /* called outside a test: caller owns it */ }
  return drizzle(pg, { schema }) as unknown as Db;
}

let seq = 0;
export async function makeStudio(db: Db, o: { name?: string; ownerEmail?: string } = {}): Promise<{ studioId: string; ownerId: string }> {
  const studioId = newId(); const ownerId = newId();
  await asSystem(db, async (tx) => {
    await tx.insert(schema.studios).values({ id: studioId, name: o.name ?? 'Test Studio' });
    await tx.insert(schema.users).values({ id: ownerId, studioId, email: o.ownerEmail ?? `owner-${++seq}-${process.pid}@x.com`, role: 'owner' });
  });
  return { studioId, ownerId };
}

/** Awaits a promise that must reject; returns the Postgres error message under drizzle's "Failed query" wrapper. */
export async function pgFail(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => { throw new Error('expected a database error, got success'); }, (err: unknown) => err);
  return pgMessage(e);
}
