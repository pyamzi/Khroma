import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const run = promisify(execFile);
export const EXIFTOOL = process.env.EXIFTOOL_PATH ?? 'exiftool';
export const PREVIEW_EDGE = 2048;
export const MEDIUM_EDGE = 1280;
export const THUMB_EDGE = 400;
/** Every child process runs on untrusted uploads: a crafted file must not hang a worker job. */
export const TOOL_LIMITS = { timeout: 30_000, killSignal: 'SIGKILL' } as const;
export class PreviewError extends Error { constructor(msg: string) { super(msg); this.name = 'PreviewError'; } }

/** Camera-rendered JPEG inside a RAW, via exiftool on a temp copy. Null when absent or exiftool is unavailable. */
async function embedded(src: Uint8Array): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'og-prev-'));
  try {
    const file = join(dir, 'src'); await writeFile(file, src);
    for (const tag of ['JpgFromRaw', 'PreviewImage', 'OtherImage']) {
      try {
        const { stdout } = await run(EXIFTOOL, ['-b', `-${tag}`, file], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, ...TOOL_LIMITS });
        if (stdout.length > 1024 && stdout[0] === 0xff && stdout[1] === 0xd8) return stdout;
      } catch { /* tag absent or exiftool missing: fall through to sharp */ }
    }
    return null;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const fit = (input: Uint8Array, maxEdge: number) => sharp(input, { failOn: 'none' }).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });

/** Embedded camera JPEG first, then the source itself. An embedded candidate that will not decode is not an error; the source is tried next. */
export async function extractPreview(src: Uint8Array, maxEdge = 2048): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const render = async (input: Uint8Array) => {
    const { data, info } = await fit(input, maxEdge).jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
    return { jpeg: data, width: info.width, height: info.height };
  };
  if (src.byteLength === 0) throw new PreviewError('no usable preview: empty file');
  const emb = await embedded(src);
  if (emb) { try { return await render(emb); } catch { /* abbreviated or damaged stream: fall through to the source */ } }
  try { return await render(src); }
  catch (e) { throw new PreviewError(`no usable preview: ${(e as Error).message}`); }
}

export async function makeThumb(src: Uint8Array, maxEdge: number): Promise<Buffer> {
  return fit(src, maxEdge).jpeg({ quality: 75 }).toBuffer();
}
