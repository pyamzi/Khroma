import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';

describe('web build', () => {
  it('produces dist/web/index.html', async () => {
    await promisify(execFile)('npx', ['vite', 'build'], { cwd: process.cwd() });
    expect((await stat('dist/web/index.html')).isFile()).toBe(true);
  }, 120_000);
});
