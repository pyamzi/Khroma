import { describe, it, expect } from 'vitest';
import { jpegBytes, pngBytes, tiffBytes, hexBytes } from '../fixtures/make.js';
import { sniffBytes, sha256 } from '../../src/server/media/sniff.js';

describe('sniffBytes', () => {
  it('identifies jpeg, png, tiff-based raw, mp4, pdf, mp3', async () => {
    expect(sniffBytes(await jpegBytes(), 'a.jpg')).toEqual({ kind: 'photo', format: 'jpeg' });
    expect(sniffBytes(await pngBytes(), 'b.png')).toEqual({ kind: 'photo', format: 'png' });
    expect(sniffBytes(await tiffBytes(), 'c.DNG')).toEqual({ kind: 'photo', format: 'raw' });
    expect(sniffBytes(hexBytes('00000018 66747970 69736f6d 00000200 69736f6d 69736f32'), 'd.mp4')).toEqual({ kind: 'video', format: 'mp4' });
    expect(sniffBytes(Buffer.from('%PDF-1.4\n%'), 'e.pdf')).toEqual({ kind: 'document', format: 'pdf' });
    expect(sniffBytes(hexBytes('494433 03000000 00'), 'f.mp3')).toEqual({ kind: 'audio', format: 'mp3' });
  });
  it('rejects a mismatched extension and unknown types', async () => {
    expect(sniffBytes(await jpegBytes(), 'fake.nef')).toBeNull();
    expect(sniffBytes(Buffer.from('MZ'), 'x.exe')).toBeNull();
    expect(sniffBytes(Buffer.from('not an image'), 'y.jpg')).toBeNull();
    expect(sniffBytes(new Uint8Array(0), 'empty.jpg')).toBeNull();
  });
});
describe('sha256', () => {
  it('is the full-content hex digest', async () => {
    expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256(await jpegBytes())).not.toBe(sha256(await jpegBytes(65, 48)));
  });
});
