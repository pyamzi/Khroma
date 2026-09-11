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

describe('watcher', () => {
  it('picks up a new project and then its media', async () => {
    const root = await tmpDir(); await mkdir(join(root, 'Clients'), { recursive: true });
    const db = openDb(':memory:'); migrate(db);
    let resolveIdle: () => void = () => {};
    const nextIdle = () => new Promise<void>((r) => { resolveIdle = r; });
    const stop = startWatcher(db, root, { debounceMs: 100, stabilityMs: 100, onIdle: () => resolveIdle() });
    try {
      let wait = nextIdle();
      await mkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true });
      await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), defaultClientJson('Smith'));
      await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), defaultProjectJson('Wedding'));
      await wait;
      expect(db.select().from(projects).all()).toHaveLength(1);
      wait = nextIdle();
      await makeTiffAs(join(root, 'Clients/Smith/Wedding/raw/a.dng'));
      await wait;
      expect(db.select().from(photos).all().map((p) => p.relPath)).toEqual(['raw/a.dng']);
    } finally { stop(); }
  }, 30000);
});
