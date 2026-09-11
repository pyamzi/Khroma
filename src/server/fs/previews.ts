import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
export const EXIFTOOL = process.env.EXIFTOOL_PATH ?? 'exiftool';
export class PreviewError extends Error { constructor(msg: string) { super(msg); this.name = 'PreviewError'; } }

/** Camera-rendered JPEG inside a RAW, via exiftool. Null when absent or exiftool is unavailable. */
async function embedded(src: string): Promise<Buffer | null> {
  for (const tag of ['JpgFromRaw', 'PreviewImage', 'OtherImage']) {
    try {
      const { stdout } = await run(EXIFTOOL, ['-b', `-${tag}`, src], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      if (stdout.length > 1024 && stdout[0] === 0xff && stdout[1] === 0xd8) return stdout;
    } catch { /* tag absent or exiftool missing: fall through to sharp */ }
  }
  return null;
}

export async function extractPreview(src: string, out: string, maxEdge = 2048): Promise<{ width: number; height: number }> {
  const input: Buffer | string = (await embedded(src)) ?? src;
  try {
    const info = await sharp(input, { failOn: 'none' }).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(out);
    return { width: info.width, height: info.height };
  } catch (e) { throw new PreviewError(`no usable preview for ${src}: ${(e as Error).message}`); }
}

export async function makeThumb(src: string, out: string, maxEdge: number): Promise<void> {
  await sharp(src, { failOn: 'none' }).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toFile(out);
}
