import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tmpDir } from '../helpers.js';
import { makeJpeg, makePng, makeTiffAs, writeBytes } from '../fixtures/make.js';
import { sniff, quickHash } from '../../src/server/fs/media.js';

describe('sniff', () => {
  it('identifies jpeg, png, tiff-based raw, mp4, pdf, mp3', async () => {
    const d = await tmpDir();
    await makeJpeg(join(d, 'a.jpg')); await makePng(join(d, 'b.png')); await makeTiffAs(join(d, 'c.dng'));
    await writeBytes(join(d, 'd.mp4'), '00000018 66747970 69736f6d 00000200 69736f6d 69736f32');
    await writeFile(join(d, 'e.pdf'), '%PDF-1.4\n%');
    await writeBytes(join(d, 'f.mp3'), '494433 03000000 00');
    expect(await sniff(join(d, 'a.jpg'))).toEqual({ kind: 'photo', format: 'jpeg' });
    expect(await sniff(join(d, 'b.png'))).toEqual({ kind: 'photo', format: 'png' });
    expect(await sniff(join(d, 'c.dng'))).toEqual({ kind: 'photo', format: 'raw' });
    expect(await sniff(join(d, 'd.mp4'))).toEqual({ kind: 'video', format: 'mp4' });
    expect(await sniff(join(d, 'e.pdf'))).toEqual({ kind: 'document', format: 'pdf' });
    expect(await sniff(join(d, 'f.mp3'))).toEqual({ kind: 'audio', format: 'mp3' });
  });
  it('rejects a mismatched extension and unknown types', async () => {
    const d = await tmpDir();
    await makeJpeg(join(d, 'fake.nef'));            // jpeg bytes, raw extension
    await writeFile(join(d, 'x.exe'), 'MZ');
    await writeFile(join(d, 'y.jpg'), 'not an image');
    await writeFile(join(d, 'empty.jpg'), '');
    expect(await sniff(join(d, 'fake.nef'))).toBeNull();
    expect(await sniff(join(d, 'x.exe'))).toBeNull();
    expect(await sniff(join(d, 'y.jpg'))).toBeNull();
    expect(await sniff(join(d, 'empty.jpg'))).toBeNull();
  });
});
describe('quickHash', () => {
  it('is stable and changes with content', async () => {
    const d = await tmpDir();
    await makeJpeg(join(d, 'a.jpg')); await makeJpeg(join(d, 'b.jpg'), 65, 48);
    expect(await quickHash(join(d, 'a.jpg'))).toBe(await quickHash(join(d, 'a.jpg')));
    expect(await quickHash(join(d, 'a.jpg'))).not.toBe(await quickHash(join(d, 'b.jpg')));
  });
});
