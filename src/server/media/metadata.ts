import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIFTOOL } from './previews.js';

const run = promisify(execFile);
export type PhotoMetadata = { capturedAt: string | null; keywords: string[]; caption: string | null };
const EMPTY: PhotoMetadata = { capturedAt: null, keywords: [], caption: null };

const list = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);

/** exiftool dates carry no zone (`2024:06:01 10:00:00`); they are read as UTC. */
function parseDate(v: unknown): string | null {
  const m = typeof v === 'string' ? /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v) : null;
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Capture date, keywords (Lightroom Subject plus IPTC Keywords) and caption, via exiftool on a temp copy. Empty values when exiftool is missing or fails. */
export async function readMetadata(bytes: Uint8Array): Promise<PhotoMetadata> {
  const dir = await mkdtemp(join(tmpdir(), 'og-meta-'));
  try {
    const file = join(dir, 'src'); await writeFile(file, bytes);
    const { stdout } = await run(EXIFTOOL, ['-j', '-n', '-DateTimeOriginal', '-Subject', '-Keywords', '-Description', '-Caption-Abstract', '-ImageDescription', file], { maxBuffer: 8 * 1024 * 1024 });
    const t = (JSON.parse(stdout) as Record<string, unknown>[])[0] ?? {};
    return {
      capturedAt: parseDate(t.DateTimeOriginal),
      keywords: [...new Set([...list(t.Subject), ...list(t.Keywords)])],
      caption: [t.Description, t['Caption-Abstract'], t.ImageDescription].map((x) => (x == null ? '' : String(x).trim())).find(Boolean) ?? null,
    };
  } catch { return EMPTY; }
  finally { await rm(dir, { recursive: true, force: true }); }
}
