import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { boot as bootApp } from './boot.js';

const sized = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#c33' } }).jpeg().toBuffer();
const jpeg = (bg = '#c33') => sharp({ create: { width: 40, height: 30, channels: 3, background: bg } }).jpeg().toBuffer();

async function boot() {
  const b = await bootApp();
  const { cookie: owner, studioId } = await b.signupOwner('owner@x.com', 'S');
  const { projectId: pid, clientId } = await b.seedProject(owner, { emails: ['sarah@x.com'], included: 5 });
  const q = await b.json<{ id: string }>(await b.post('/api/projects', { clientId, title: 'Other' }, owner));
  await b.addCulling(studioId, pid, ['a', 'b']);
  const sarah = await b.signIn('sarah@x.com');
  const mint = async (body: unknown) => b.json<{ id: string; token: string }>(await b.post('/api/access/tokens', body, owner));
  return { ...b, owner, sarah, pid, qid: q.id, mint };
}
type Photo = { id: string; relPath: string; pick: null | { locked: boolean } };

describe('plugin api', () => {
  it('walks the plugin flow with a bearer token', async () => {
    const { api, json, drain, owner, sarah, pid, qid, mint } = await boot();
    expect((await api('/api/plugin/me')).status).toBe(401);
    expect((await api('/api/plugin/me', { cookie: owner })).status).toBe(401); // admins are not plugins
    const rw = await mint({ name: 'Sam', scope: 'read+write' });
    const ro = await mint({ name: 'Viewer', scope: 'read' });
    const scoped = await mint({ name: 'One', scope: 'read+write', projectId: qid });
    expect(await json<{ name: string; studio: string }>(await api('/api/plugin/me', { bearer: rw.token }))).toMatchObject({ name: 'Sam', scope: 'read+write', studio: 'S' });
    const projects = await json<{ id: string; title: string; client: string; folders: { finals: string } }[]>(await api('/api/plugin/projects', { bearer: rw.token }));
    expect(projects.map((p) => p.title).sort()).toEqual(['Other', 'Wedding']); expect(projects[0]!.client).toBe('Smith');
    expect((await json<unknown[]>(await api('/api/plugin/projects', { bearer: scoped.token }))).length).toBe(1);
    expect((await api(`/api/plugin/projects/${pid}/picks`, { bearer: scoped.token })).status).toBe(404); // scoped to Other
    // resolve paths → source ids
    const res = await json<{ paths: Record<string, string | null> }>(await api(`/api/plugin/projects/${pid}/resolve`, { method: 'POST', bearer: rw.token, body: JSON.stringify({ paths: ['raw/a.dng', 'raw/b.dng', 'raw/nope.dng'] }) }));
    const a = res.paths['raw/a.dng']!; const b = res.paths['raw/b.dng']!; expect(a && b).toBeTruthy(); expect(res.paths['raw/nope.dng']).toBeNull();
    // upload two finals with the same name from two sources; read-only token refused
    const up = async (token: string, name: string, src: string, uploadId: string, bg = '#c33') => { const fd = new FormData(); fd.append('file', new Blob([await jpeg(bg)], { type: 'image/jpeg' }), name); fd.append('name', name); fd.append('sourcePhotoId', src); fd.append('uploadId', uploadId); return api(`/api/plugin/projects/${pid}/finals`, { method: 'POST', body: fd, bearer: token }); };
    expect((await up(ro.token, 'DSC_1.jpg', a, 'u0')).status).toBe(403);
    let r = await up(rw.token, 'DSC_1.jpg', a, 'u1'); expect(r.status).toBe(201); const f1 = await json<{ photoId: string; relPath: string }>(r);
    r = await up(rw.token, 'DSC_1.jpg', b, 'u2'); expect(r.status).toBe(201); const f2 = await json<{ photoId: string; relPath: string }>(r);
    expect([f1.relPath, f2.relPath]).toEqual(['finals/DSC_1.jpg', 'finals/DSC_1 (2).jpg']);
    r = await up(rw.token, 'DSC_1.jpg', a, 'u1'); expect(r.status).toBe(200); expect((await json<{ idempotent: boolean }>(r)).idempotent).toBe(true);
    await drain();
    // drafts are invisible to the client, visible to the admin, and the client cannot fetch their preview
    expect((await json<Photo[]>(await api(`/api/projects/${pid}/photos?stage=final`, { cookie: sarah }))).length).toBe(0);
    expect((await json<Photo[]>(await api(`/api/projects/${pid}/photos?stage=final`, { cookie: owner }))).length).toBe(2);
    expect((await api(`/api/photos/${f1.photoId}/preview?size=thumb`, { cookie: sarah })).status).toBe(404);
    expect((await api(`/api/photos/${f1.photoId}/preview?size=thumb&draft=1`, { cookie: owner })).status).toBe(200);
    // client picks and finishes → plugin sees submitted picks
    const sel = await json<{ summary: { selectionVersion: number } }>(await api(`/api/projects/${pid}/selection`, { cookie: sarah }));
    await api(`/api/projects/${pid}/picks`, { method: 'POST', cookie: sarah, body: JSON.stringify({ photoId: a, picked: true, selectionVersion: sel.summary.selectionVersion }) });
    expect((await json<{ picks: unknown[] }>(await api(`/api/plugin/projects/${pid}/picks`, { bearer: rw.token }))).picks).toEqual([]);
    const sel2 = await json<{ summary: { selectionVersion: number } }>(await api(`/api/projects/${pid}/selection`, { cookie: sarah }));
    expect((await api(`/api/projects/${pid}/finish`, { method: 'POST', cookie: sarah, body: JSON.stringify({ selectionVersion: sel2.summary.selectionVersion }) })).status).toBe(200);
    const picks = await json<{ round: number; picks: { photoId: string; relPath: string }[] }>(await api(`/api/plugin/projects/${pid}/picks`, { bearer: rw.token }));
    expect(picks).toMatchObject({ round: 1, picks: [{ photoId: a, relPath: 'raw/a.dng' }] });
    // comments with hints, a reply from Lightroom, progress
    await api(`/api/photos/${a}/comments`, { method: 'POST', cookie: sarah, body: JSON.stringify({ text: 'brighter', x: 0.7, y: 0.7, w: 0.2, h: 0.2 }) });
    const cs = await json<{ text: string; hint: string | null; relPath: string }[]>(await api(`/api/plugin/projects/${pid}/comments`, { bearer: rw.token }));
    expect(cs).toEqual([expect.objectContaining({ text: 'brighter', hint: 'bottom-right', relPath: 'raw/a.dng' })]);
    expect((await api(`/api/plugin/photos/${a}/comments`, { method: 'POST', bearer: rw.token, body: JSON.stringify({ text: 'will do' }) })).status).toBe(201);
    expect((await json<unknown[]>(await api(`/api/plugin/projects/${pid}/comments`, { bearer: rw.token }))).length).toBe(2);
    expect(await json<unknown>(await api(`/api/plugin/projects/${pid}/progress`, { method: 'POST', bearer: rw.token, body: JSON.stringify({ reports: [{ photoId: a, state: 'editing' }, { photoId: b, state: 'editing' }] }) }))).toEqual({ updated: 1, skipped: 1 });
    expect((await json<{ progress: { done: number; total: number } }>(await api(`/api/projects/${pid}`, { cookie: sarah }))).progress).toEqual({ done: 0, total: 1 });
    // delete a draft; a scoped token cannot touch it; a live final is refused
    expect((await api(`/api/plugin/finals/${f2.photoId}`, { method: 'DELETE', bearer: scoped.token })).status).toBe(404);
    expect((await api(`/api/plugin/finals/${f2.photoId}`, { method: 'DELETE', bearer: rw.token })).status).toBe(200);
    expect((await api(`/api/plugin/finals/${f2.photoId}`, { method: 'DELETE', bearer: rw.token })).status).toBe(404);
    // create a project from the plugin; a scoped token cannot
    const cl = await json<{ id: string }[]>(await api('/api/plugin/clients', { bearer: rw.token }));
    expect((await api('/api/plugin/projects', { method: 'POST', bearer: scoped.token, body: JSON.stringify({ clientId: cl[0]!.id, title: 'X' }) })).status).toBe(403);
    expect((await api('/api/plugin/projects', { method: 'POST', bearer: rw.token, body: JSON.stringify({ clientId: cl[0]!.id, title: 'Engagement' }) })).status).toBe(201);
    // revoke → 401
    expect((await api(`/api/access/tokens/${rw.id}`, { method: 'DELETE', cookie: owner })).status).toBe(200);
    expect((await api('/api/plugin/me', { bearer: rw.token })).status).toBe(401);
    expect((await json<{ id: string }[]>(await api('/api/access/tokens', { cookie: owner }))).map((t) => t.id).sort()).toEqual([ro.id, scoped.id].sort());
  });
  describe('culling previews', () => {
    const send = async (b: Awaited<ReturnType<typeof boot>>, token: string, pid: string, relPath: string, bytes: Uint8Array | Buffer) => {
      const fd = new FormData(); fd.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'x.jpg'); fd.append('relPath', relPath);
      return b.api(`/api/plugin/projects/${pid}/culling`, { method: 'POST', body: fd, bearer: token });
    };
    it('the plugin sends a culling preview that is not a Library photo', async () => {
      const b = await boot(); const rw = await b.mint({ name: 'Sam', scope: 'read+write' });
      const before = await b.json<{ total: number }>(await b.api('/api/library', { cookie: b.owner }));
      expect((await b.json<{ state: { production: string } }>(await b.api(`/api/projects/${b.qid}`, { cookie: b.owner }))).state.production).toBe('not_started');
      const r = await send(b, rw.token, b.qid, 'C:\\shoot\\IMG_1.CR3', await jpeg()); expect(r.status).toBe(201);
      expect(await b.json<{ created: boolean; replaced: boolean }>(r)).toMatchObject({ created: true, replaced: false });
      expect((await b.json<Photo[]>(await b.api(`/api/projects/${b.qid}/photos?stage=culling`, { cookie: b.owner }))).map((p) => p.relPath)).toEqual(['raw/IMG_1.CR3']);
      expect((await b.json<{ total: number }>(await b.api('/api/library', { cookie: b.owner }))).total).toBe(before.total);
      expect((await b.json<{ state: { production: string } }>(await b.api(`/api/projects/${b.qid}`, { cookie: b.owner }))).state.production).toBe('culling');
      const ro = await b.mint({ name: 'Viewer', scope: 'read' });
      expect((await send(b, ro.token, b.qid, 'raw/IMG_2.CR3', await jpeg())).status).toBe(403);
      expect((await send(b, rw.token, b.qid, '', await jpeg())).status).toBe(400);
    });
    it('re-sending the same preview is a no-op; changed bytes replace it and keep picks', async () => {
      const b = await boot(); const rw = await b.mint({ name: 'Sam', scope: 'read+write' });
      const first = await b.json<{ photoId: string }>(await send(b, rw.token, b.pid, 'raw/IMG_1.CR3', await sized(40, 30))); await b.drain();
      const same = await send(b, rw.token, b.pid, 'raw/IMG_1.CR3', await sized(40, 30)); expect(same.status).toBe(200);
      expect(await b.json<unknown>(same)).toEqual({ photoId: first.photoId, created: false, replaced: false });
      const sel = await b.json<{ summary: { selectionVersion: number } }>(await b.api(`/api/projects/${b.pid}/selection`, { cookie: b.sarah }));
      await b.api(`/api/projects/${b.pid}/picks`, { method: 'POST', cookie: b.sarah, body: JSON.stringify({ photoId: first.photoId, picked: true, selectionVersion: sel.summary.selectionVersion }) });
      const rep = await send(b, rw.token, b.pid, 'raw/IMG_1.CR3', await sized(80, 60)); expect(rep.status).toBe(200);
      expect(await b.json<unknown>(rep)).toEqual({ photoId: first.photoId, created: false, replaced: true });
      const list = async () => (await b.json<(Photo & { width: number })[]>(await b.api(`/api/projects/${b.pid}/photos?stage=culling`, { cookie: b.sarah }))).find((p) => p.id === first.photoId)!;
      expect((await list()).width).toBe(40); // dimensions wait for the new preview job
      await b.drain();
      expect(await list()).toMatchObject({ width: 80, pick: { state: 'confirmed' } });
    });
    it('refuses a non-JPEG preview with 415 and an oversize one with 413', async () => {
      const b = await boot(); const rw = await b.mint({ name: 'Sam', scope: 'read+write' });
      expect((await send(b, rw.token, b.pid, 'raw/IMG_1.CR3', await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer())).status).toBe(415);
      expect((await send(b, rw.token, b.pid, 'raw/IMG_1.CR3', Buffer.concat([await jpeg(), Buffer.alloc(30 * 1024 * 1024)]))).status).toBe(413);
    });
  });
});
