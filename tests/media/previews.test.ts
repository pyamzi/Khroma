import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { jpegBytes, tiffBytes } from '../fixtures/make.js';
import { extractPreview, makeThumb, PreviewError } from '../../src/server/media/previews.js';

describe('previews', () => {
  it('falls back to sharp for a raw without an embedded preview', async () => {
    const r = await extractPreview(await tiffBytes(), 16);
    expect([r.width, r.height]).toEqual([16, 12]);
    expect((await sharp(r.jpeg).metadata()).format).toBe('jpeg');
  });
  it('ignores an embedded candidate that does not decode (jpeg-compressed tiff strips) and renders the source', async () => {
    const r = await extractPreview(await tiffBytes(600, 400), 300);
    expect([r.width, r.height]).toEqual([300, 200]);
  });
  it('throws PreviewError for empty or undecodable bytes', async () => {
    await expect(extractPreview(new Uint8Array(0))).rejects.toBeInstanceOf(PreviewError);
    await expect(extractPreview(Buffer.from('49492a00', 'hex'))).rejects.toBeInstanceOf(PreviewError);
  });
  it('makes a thumbnail', async () => {
    const t = await makeThumb(await jpegBytes(640, 480), 100);
    expect((await sharp(t).metadata()).width).toBe(100);
  });
  it.skipIf(!process.env.OPENGALLERY_RAW_FIXTURE)('uses the embedded preview of a real RAW', async () => {
    const r = await extractPreview(await readFile(process.env.OPENGALLERY_RAW_FIXTURE!), 2048);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(2048);
  });
});
