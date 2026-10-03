import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);
const SDK_REL = 'References/LrC_15.3_202604090947-8f3672ed.release_SDK/Lua Compiler/mac/luac';
const CANDIDATES = [process.env.LRC_SDK_LUAC, SDK_REL, join('../../OpenGallery', SDK_REL)].filter((x): x is string => !!x); // worktrees sit beside the main checkout
const exists = (p: string) => stat(p).then(() => true, () => false);
const compilers: string[] = [];
for (const c of CANDIDATES) if (await exists(c)) { compilers.push(c); break; }
if (await run('luac', ['-v']).then(() => true, () => false)) compilers.push('luac');

describe.skipIf(compilers.length === 0)('plugin Lua syntax', () => {
  it('every plugin file compiles', async () => {
    const dir = 'plugin/OpenGallery.lrplugin';
    const files = (await readdir(dir)).filter((f) => f.endsWith('.lua')).map((f) => join(dir, f));
    expect(files.length).toBeGreaterThan(3);
    for (const c of compilers) for (const f of files) await run(c, ['-p', f]).catch((e: { stderr?: string }) => { throw new Error(`${c} ${f}: ${e.stderr ?? e}`); });
  });
});
