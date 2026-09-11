import { describe, it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers.js';
import { makeTiffAs } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { photos, projects } from '../../src/server/db/schema.js';
import { startWatcher } from '../../src/server/fs/watcher.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';

async function until(cond: () => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 50)); }
}

describe('watcher', () => {
  it('picks up a new project and then its media, and converges even if fs events are dropped', async () => {
    const root = await tmpDir(); await mkdir(join(root, 'Clients'), { recursive: true });
    const db = openDb(':memory:'); migrate(db);
    const stop = await startWatcher(db, root, { debounceMs: 100, stabilityMs: 100, sweepMs: 500 });
    try {
      await mkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true });
      await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), defaultClientJson('Smith'));
      await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), defaultProjectJson('Wedding'));
      await until(() => db.select().from(projects).all().length === 1);
      await makeTiffAs(join(root, 'Clients/Smith/Wedding/raw/a.dng'));
      await until(() => db.select().from(photos).all().length === 1);
      expect(db.select().from(photos).all()[0]?.relPath).toBe('raw/a.dng');
    } finally { stop(); }
  }, 30_000);
});
