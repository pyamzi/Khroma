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
