import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const created: string[] = [];
export async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'og-'));
  created.push(d);
  return d;
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});
