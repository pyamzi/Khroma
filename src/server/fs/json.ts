import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ZodType } from 'zod';

export type ReadResult<T> = { ok: true; data: T } | { ok: false; error: string; missing?: boolean };

export async function readJson<T>(file: string, schema: ZodType<T>): Promise<ReadResult<T>> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (e) { const code = (e as NodeJS.ErrnoException).code; return { ok: false, error: String(e), missing: code === 'ENOENT' }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, error: `invalid JSON: ${(e as Error).message}` }; }
  const r = schema.safeParse(parsed);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

/** Write via a same-directory temp file and atomic rename; never leaves a partial file behind. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try { await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8'); await rename(tmp, file); }
  catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}
