import { describe, it, expect } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers.js';
import { resolveInside, isReserved, PathError } from '../../src/server/fs/paths.js';

describe('resolveInside', () => {
  it('resolves a normal relative path', async () => {
    const root = await tmpDir();
    await mkdir(join(root, 'Clients/A'), { recursive: true });
    expect(await resolveInside(root, 'Clients/A')).toBe(join(root, 'Clients/A'));
  });
  it('rejects traversal', async () => {
    const root = await tmpDir();
    await expect(resolveInside(root, '../etc/passwd')).rejects.toBeInstanceOf(PathError);
    await expect(resolveInside(root, 'Clients/../../x')).rejects.toBeInstanceOf(PathError);
    await expect(resolveInside(root, '/absolute')).rejects.toBeInstanceOf(PathError);
  });
  it('rejects a symlink that escapes the root', async () => {
    const root = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(outside, 'secret'), 'x');
    await symlink(outside, join(root, 'link'));
    await expect(resolveInside(root, 'link/secret')).rejects.toBeInstanceOf(PathError);
  });
  it('allows a path whose leaf does not exist yet', async () => {
    const root = await tmpDir();
    expect(await resolveInside(root, 'Clients/new.json')).toBe(join(root, 'Clients/new.json'));
  });
  it('knows reserved directories', () => {
    expect(isReserved('Clients/A/P/.draft/x.jpg')).toBe(true);
    expect(isReserved('Clients/A/P/finals/x.jpg')).toBe(false);
    expect(isReserved('.trash')).toBe(true);
  });
});
