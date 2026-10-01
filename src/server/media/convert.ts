import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { extractPreview, makeThumb, PreviewError, PREVIEW_EDGE, MEDIUM_EDGE, THUMB_EDGE, TOOL_LIMITS } from './previews.js';

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

/** heif-convert writes out.jpg for one image and out-1.jpg, out-2.jpg, ... for several; the first is the primary image. */
export function pickHeicOutput(names: string[]): string | null {
  if (names.includes('out.jpg')) return 'out.jpg';
  const n = names.flatMap((f) => { const m = /^out-(\d+)\.jpg$/.exec(f); return m ? [{ f, i: Number(m[1]) }] : []; });
  return n.sort((a, b) => a.i - b.i)[0]?.f ?? null;
}

/** HEIC to JPEG with libheif's heif-convert, on temp files. */
export async function heicToJpeg(bytes: Uint8Array, o: { tool?: string; timeoutMs?: number } = {}): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'og-heic-'));
  try {
    await writeFile(join(dir, 'in.heic'), bytes);
    await run(o.tool ?? 'heif-convert', ['-q', '92', join(dir, 'in.heic'), join(dir, 'out.jpg')], { ...TOOL_LIMITS, timeout: o.timeoutMs ?? TOOL_LIMITS.timeout });
    const out = pickHeicOutput(await readdir(dir));
    if (!out) throw new Error('no output image');
    return await readFile(join(dir, out));
  } catch (e) { throw new PreviewError(`heic conversion failed: ${(e as Error).message}`); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
