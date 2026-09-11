import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep, dirname } from 'node:path';

export const RESERVED_DIRS = ['.draft', '.cache', '.trash'] as const;
export class PathError extends Error { constructor(msg: string) { super(msg); this.name = 'PathError'; } }

export function isReserved(rel: string): boolean {
  return normalize(rel).split(sep).some((p) => (RESERVED_DIRS as readonly string[]).includes(p));
}

function inside(rootAbs: string, p: string): boolean {
  const r = relative(rootAbs, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Resolve `rel` under `root`; the deepest existing ancestor must realpath inside `root`. */
export async function resolveInside(root: string, rel: string): Promise<string> {
  if (isAbsolute(rel)) throw new PathError('absolute path not allowed');
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, normalize(rel));
  if (!inside(rootAbs, abs)) throw new PathError(`escapes root: ${rel}`);
  const rootReal = await realpath(rootAbs);
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!inside(rootReal, real)) throw new PathError(`symlink escapes root: ${rel}`);
      break;
    } catch (e) {
      if (e instanceof PathError) throw e;
      const up = dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  return abs;
}

export function projectRel(root: string, abs: string): string {
  return relative(resolve(root), abs).split(sep).join('/');
}
