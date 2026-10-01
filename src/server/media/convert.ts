import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { extractPreview, makeThumb, PreviewError } from './previews.js';
import { PREVIEW_EDGE, MEDIUM_EDGE, THUMB_EDGE } from '../domain/photos.js';

const run = promisify(execFile);

/** All three renditions plus the source's EXIF-oriented size. Medium and thumb are cut from the preview, not the source. */
export async function renderSizes(src: Uint8Array): Promise<{ thumb: Buffer; medium: Buffer; preview: Buffer; width: number; height: number }> {
  const r = await extractPreview(src, PREVIEW_EDGE);
  let width = r.width, height = r.height; // a source sharp cannot read (some RAW) reports its preview size
  try {
    const m = await sharp(src, { failOn: 'none' }).metadata();
    if (m.width && m.height) [width, height] = (m.orientation ?? 1) >= 5 ? [m.height, m.width] : [m.width, m.height];
  } catch { /* keep the preview size */ }
  return { preview: r.jpeg, medium: await makeThumb(r.jpeg, MEDIUM_EDGE), thumb: await makeThumb(r.jpeg, THUMB_EDGE), width, height };
}

/** HEIC to JPEG with libheif's heif-convert, on temp files. */
export async function heicToJpeg(bytes: Uint8Array): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'og-heic-'));
  try {
    const out = join(dir, 'out.jpg'); await writeFile(join(dir, 'in.heic'), bytes);
    await run('heif-convert', ['-q', '92', join(dir, 'in.heic'), out]);
    return await readFile(out);
  } catch (e) { throw new PreviewError(`heic conversion failed: ${(e as Error).message}`); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
