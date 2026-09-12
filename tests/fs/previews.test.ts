import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { tmpDir } from '../helpers.js';
import { makeJpeg, makeTiffAs } from '../fixtures/make.js';
import { extractPreview, makeThumb, PreviewError } from '../../src/server/fs/previews.js';

describe('previews', () => {
  it('falls back to sharp for a raw without an embedded preview', async () => {
    const d = await tmpDir(); await makeTiffAs(join(d, 'x.dng'));
    const r = await extractPreview(join(d, 'x.dng'), join(d, 'x.jpg'), 16);
    expect(r).toEqual({ width: 16, height: 12 });
    expect((await sharp(join(d, 'x.jpg')).metadata()).format).toBe('jpeg');
  });
  it('ignores an embedded candidate that does not decode (jpeg-compressed tiff strips) and renders the source', async () => {
    const d = await tmpDir();
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#3c3' } }).tiff().toFile(join(d, 'big.dng'));
    const r = await extractPreview(join(d, 'big.dng'), join(d, 'big.jpg'), 300);
    expect(r).toEqual({ width: 300, height: 200 });
  });
  it('throws PreviewError for a missing or undecodable file', async () => {
    const d = await tmpDir();
    await expect(extractPreview(join(d, 'missing.cr2'), join(d, 'o.jpg'))).rejects.toBeInstanceOf(PreviewError);
    await writeFile(join(d, 'bad.nef'), Buffer.from('49492a00', 'hex'));
    await expect(extractPreview(join(d, 'bad.nef'), join(d, 'o.jpg'))).rejects.toBeInstanceOf(PreviewError);
  });
  it('makes a thumbnail', async () => {
    const d = await tmpDir(); await makeJpeg(join(d, 'a.jpg'), 640, 480);
    await makeThumb(join(d, 'a.jpg'), join(d, 't.jpg'), 100);
    expect((await sharp(join(d, 't.jpg')).metadata()).width).toBe(100);
  });
  it.skipIf(!process.env.OPENGALLERY_RAW_FIXTURE)('uses the embedded preview of a real RAW', async () => {
    const d = await tmpDir();
    const r = await extractPreview(process.env.OPENGALLERY_RAW_FIXTURE!, join(d, 'r.jpg'), 2048);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(2048);
  });
});
