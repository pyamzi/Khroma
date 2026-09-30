import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export type Sniffed = { kind: 'photo' | 'video' | 'document' | 'audio'; format: 'jpeg' | 'png' | 'heic' | 'raw' | 'mp4' | 'mov' | 'pdf' | 'mp3' | 'm4a' | 'wav' };

const RAW_EXT = new Set(['.nef', '.cr2', '.cr3', '.arw', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw']);
const EXT: Record<string, Sniffed> = {
  '.jpg': { kind: 'photo', format: 'jpeg' }, '.jpeg': { kind: 'photo', format: 'jpeg' }, '.png': { kind: 'photo', format: 'png' },
  '.heic': { kind: 'photo', format: 'heic' }, '.mp4': { kind: 'video', format: 'mp4' }, '.m4v': { kind: 'video', format: 'mp4' },
  '.mov': { kind: 'video', format: 'mov' }, '.pdf': { kind: 'document', format: 'pdf' }, '.mp3': { kind: 'audio', format: 'mp3' },
  '.m4a': { kind: 'audio', format: 'm4a' }, '.wav': { kind: 'audio', format: 'wav' },
};

const isTiff = (b: Buffer) => b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a));
const isFtyp = (b: Buffer, brands: string[]) => b.length >= 12 && b.subarray(4, 8).toString() === 'ftyp' && brands.some((x) => b.subarray(8, 12).toString().startsWith(x));

/** Extension allowlist checked against the file signature. Null means unsupported or mismatched; never store or serve it. */
export function sniffBytes(bytes: Uint8Array, name: string): Sniffed | null {
  const ext = extname(name).toLowerCase();
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(16, bytes.byteLength));
  if (b.length < 4) return null;
  if (RAW_EXT.has(ext)) {
    const ok = isTiff(b) || (ext === '.cr3' && isFtyp(b, ['crx'])) || (ext === '.raf' && b.subarray(0, 8).toString() === 'FUJIFILM') || (ext === '.rw2' && b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x55);
    return ok ? { kind: 'photo', format: 'raw' } : null;
  }
  const want = EXT[ext]; if (!want) return null;
  const checks: Record<Sniffed['format'], () => boolean> = {
    jpeg: () => b[0] === 0xff && b[1] === 0xd8,
    png: () => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    heic: () => isFtyp(b, ['heic', 'heix', 'mif1']),
    mp4: () => isFtyp(b, ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V']),
    mov: () => isFtyp(b, ['qt']),
    pdf: () => b.subarray(0, 4).toString() === '%PDF',
    mp3: () => b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0),
    m4a: () => isFtyp(b, ['M4A']),
    wav: () => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE',
    raw: () => false,
  };
  return checks[want.format]() ? want : null;
}

export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
