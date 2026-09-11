import { describe, it, expect } from 'vitest';
import { stat } from 'node:fs/promises';
import { tmpDir } from './helpers.js';

describe('harness', () => {
  it('creates a temp dir', async () => {
    const d = await tmpDir();
    expect((await stat(d)).isDirectory()).toBe(true);
  });
});
