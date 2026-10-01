import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { startTestServer } from '../e2e/server.js';
import { tmpDir } from '../helpers.js';

const run = promisify(execFile);
const hasLua = await run('lua', ['-v']).then(() => true, () => false);

describe.skipIf(!hasLua)('plugin Lua API module against the live server', () => {
  it('walks the plugin flow from Lua', async () => {
    const srv = await startTestServer();
    try {
      const j = async (path: string, init: RequestInit & { cookie?: string } = {}) => fetch(srv.baseUrl + path, { ...init, headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) } });
      const owner = await srv.signInCookie('owner@x.com'); const sarah = await srv.signInCookie('sarah@x.com');
      // the client picks one RAW, comments on it, and finishes
      const photos = await (await j(`/api/projects/${srv.projectId}/photos?stage=culling`, { cookie: sarah })).json() as { id: string }[];
      const sel = await (await j(`/api/projects/${srv.projectId}/selection`, { cookie: sarah })).json() as { summary: { selectionVersion: number } };
      await j(`/api/projects/${srv.projectId}/picks`, { method: 'POST', cookie: sarah, body: JSON.stringify({ photoId: photos[0]!.id, picked: true, selectionVersion: sel.summary.selectionVersion }) });
      await j(`/api/photos/${photos[0]!.id}/comments`, { method: 'POST', cookie: sarah, body: JSON.stringify({ text: 'soften', x: 0.05, y: 0.05, w: 0.1, h: 0.1 }) });
      const sel2 = await (await j(`/api/projects/${srv.projectId}/selection`, { cookie: sarah })).json() as { summary: { selectionVersion: number } };
      expect((await j(`/api/projects/${srv.projectId}/finish`, { method: 'POST', cookie: sarah, body: JSON.stringify({ selectionVersion: sel2.summary.selectionVersion }) })).status).toBe(200);
      const { token } = await (await j('/api/access/tokens', { method: 'POST', cookie: owner, body: JSON.stringify({ name: 'lua', scope: 'read+write' }) })).json() as { token: string };
      const dir = await tmpDir(); const jpeg = join(dir, 'final.jpg'); await writeFile(jpeg, await sharp({ create: { width: 40, height: 30, channels: 3, background: '#36c' } }).jpeg().toBuffer());
      const { stdout, stderr } = await run('lua', ['tests/plugin/api_test.lua', srv.baseUrl, token, jpeg, 'plugin/OpenGallery.lrplugin', 'tests/plugin'], { cwd: process.cwd() })
        .catch((e: { stdout?: string; stderr?: string; message: string }) => { throw new Error(`lua failed\n${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}`); });
      expect(stderr).toBe(''); expect(stdout.trim()).toBe('OK');
    } finally { await srv.stop(); }
  }, 60_000);
});
