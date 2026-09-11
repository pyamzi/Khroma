import { describe, it, expect } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { tmpDir } from '../helpers.js';
import { readJson, writeJsonAtomic } from '../../src/server/fs/json.js';

const S = z.object({ a: z.number() });
describe('json', () => {
  it('writes atomically and leaves no temp file', async () => {
    const d = await tmpDir();
    await writeJsonAtomic(join(d, 'x.json'), { a: 1 });
    expect(JSON.parse(await readFile(join(d, 'x.json'), 'utf8'))).toEqual({ a: 1 });
    expect(await readdir(d)).toEqual(['x.json']);
  });
  it('reads and validates', async () => {
    const d = await tmpDir();
    await writeFile(join(d, 'bad.json'), '{ not json');
    await writeFile(join(d, 'wrong.json'), '{"a":"str"}');
    expect((await readJson(join(d, 'bad.json'), S)).ok).toBe(false);
    expect((await readJson(join(d, 'wrong.json'), S)).ok).toBe(false);
    const missing = await readJson(join(d, 'none.json'), S);
    expect(missing.ok === false && missing.missing).toBe(true);
    await writeJsonAtomic(join(d, 'ok.json'), { a: 2 });
    const r = await readJson(join(d, 'ok.json'), S);
    expect(r.ok && r.data.a).toBe(2);
  });
});
