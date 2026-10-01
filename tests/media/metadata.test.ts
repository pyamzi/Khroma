import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { jpegBytes } from '../fixtures/make.js';
import { readMetadata } from '../../src/server/media/metadata.js';
import { renderSizes, heicToJpeg } from '../../src/server/media/convert.js';
import { EXIFTOOL, PreviewError } from '../../src/server/media/previews.js';

const run = promisify(execFile);
const has = async (cmd: string) => { try { await run(cmd, ['-ver']); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT'; } };
const hasExiftool = await has(EXIFTOOL);
const hasHeifConvert = await has('heif-convert');
const hasHeifEnc = await has('heif-enc');

describe('readMetadata', () => {
  it.skipIf(!hasExiftool)('reads date, Lightroom keywords and caption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'og-meta-test-'));
    try {
      const f = join(dir, 'a.jpg'); await writeFile(f, await jpegBytes());
      await run(EXIFTOOL, ['-overwrite_original', '-DateTimeOriginal=2024:06:01 10:00:00', '-Subject=beach', '-Subject=dusk', '-Keywords=dusk', '-Description=Couple on the pier', f]);
      expect(await readMetadata(await readFile(f))).toEqual({ capturedAt: '2024-06-01T10:00:00.000Z', keywords: ['beach', 'dusk'], caption: 'Couple on the pier' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.skipIf(!hasExiftool)('returns empty values for a file without metadata', async () => {
    expect(await readMetadata(await jpegBytes())).toEqual({ capturedAt: null, keywords: [], caption: null });
  });
});

describe('renderSizes', () => {
  it('keeps the source size and caps each edge', async () => {
    const r = await renderSizes(await jpegBytes(3000, 2000));
    expect([r.width, r.height]).toEqual([3000, 2000]);
    expect((await sharp(r.preview).metadata()).width).toBe(2048);
    expect((await sharp(r.medium).metadata()).width).toBe(1280);
    expect((await sharp(r.thumb).metadata()).width).toBe(400);
  });
  it('reports the EXIF-oriented size', async () => {
    const rotated = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#4a90e2' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = await renderSizes(rotated);
    expect([r.width, r.height]).toEqual([200, 300]);
  });
});

describe('heicToJpeg', () => {
  it.skipIf(!hasHeifConvert || !hasHeifEnc)('converts HEIC to JPEG', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'og-heic-test-'));
    try {
      await writeFile(join(dir, 'a.jpg'), await jpegBytes(64, 48));
      await run('heif-enc', [join(dir, 'a.jpg'), '-o', join(dir, 'a.heic')]);
      expect((await sharp(await heicToJpeg(await readFile(join(dir, 'a.heic')))).metadata()).format).toBe('jpeg');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.skipIf(!hasHeifConvert)('throws PreviewError for bytes that are not HEIC', async () => {
    await expect(heicToJpeg(Buffer.from('not a heic'))).rejects.toBeInstanceOf(PreviewError);
  });
});
