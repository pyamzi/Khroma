import { Hono } from 'hono';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { AppEnv } from '../session.js';
import { requireKind } from '../access.js';
import { fail } from '../errors.js';
import { listDir, mkdir, move, trash, restore, listTrash, writeUpload, norm, FilesError } from '../../domain/files.js';
import { resolveInside, isReserved } from '../../fs/paths.js';
import { sniff } from '../../fs/media.js';

const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', raw: 'application/octet-stream', mp4: 'video/mp4', mov: 'video/quicktime', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' };

export const fileRoutes = (photosDir: string) => new Hono<AppEnv>()
  .use('/api/files/*', requireKind('admin'))
  .use('/api/files', requireKind('admin'))
  .get('/api/files', async (c) => { try { return c.json(await listDir(c.get('db'), photosDir, c.req.query('path') ?? '')); } catch (e) { return fail(c, e); } })
  .get('/api/files/trash', async (c) => c.json(await listTrash(photosDir)))
  .post('/api/files/mkdir', async (c) => {
    const b = z.object({ path: z.string().min(1) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await mkdir(c.get('db'), photosDir, b.data.path, c.get('session')!.subject), 201); } catch (e) { return fail(c, e); }
  })
  .post('/api/files/move', async (c) => {
    const b = z.object({ from: z.string().min(1), to: z.string().min(1), confirm: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await move(c.get('db'), photosDir, { ...b.data, actor: c.get('session')!.subject })); } catch (e) { return fail(c, e); }
  })
  .post('/api/files/trash', async (c) => {
    const b = z.object({ path: z.string().min(1) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await trash(c.get('db'), photosDir, { rel: b.data.path, actor: c.get('session')!.subject })); } catch (e) { return fail(c, e); }
  })
  .post('/api/files/restore', async (c) => {
    const b = z.object({ trashRel: z.string().min(1) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await restore(c.get('db'), photosDir, { trashRel: b.data.trashRel, actor: c.get('session')!.subject })); } catch (e) { return fail(c, e); }
  })
  .post('/api/files/upload', async (c) => {
    const body = await c.req.parseBody(); const f = body['file'];
    if (!(f instanceof File)) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await writeUpload(c.get('db'), photosDir, { dirRel: c.req.query('path') ?? '', name: f.name, bytes: Buffer.from(await f.arrayBuffer()), size: f.size, actor: c.get('session')!.subject }), 201); }
    catch (e) { return fail(c, e); }
  })
  .get('/api/files/download', async (c) => {
    const rel = norm(c.req.query('path') ?? '');
    try {
      if (!rel || isReserved(rel) || ['client.json', 'project.json'].includes(basename(rel))) throw new FilesError('reserved');
      const abs = await resolveInside(photosDir, rel); const s = await stat(abs).catch(() => null);
      if (!s || !s.isFile()) throw new FilesError('not_found');
      const sn = await sniff(abs).catch(() => null);
      const type = sn ? MIME[sn.format] ?? 'application/octet-stream' : 'application/octet-stream';
      const inline = !!sn && sn.kind !== 'document' ? true : sn?.format === 'pdf';
      c.header('content-type', type); c.header('content-length', String(s.size)); c.header('x-content-type-options', 'nosniff');
      c.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(basename(rel))}"`);
      return c.body(Readable.toWeb(createReadStream(abs)) as ReadableStream);
    } catch (e) { return fail(c, e); }
  });
