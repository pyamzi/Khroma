import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
export async function makeJpeg(file: string, w = 64, h = 48) { await sharp({ create: { width: w, height: h, channels: 3, background: '#4a90e2' } }).jpeg().toFile(file); }
export async function makePng(file: string) { await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toFile(file); }
export async function makeTiffAs(file: string) { await sharp({ create: { width: 32, height: 24, channels: 3, background: '#c33' } }).tiff().toFile(file); }
export async function writeBytes(file: string, hex: string) { await writeFile(file, Buffer.from(hex.replace(/\s+/g, ''), 'hex')); }
