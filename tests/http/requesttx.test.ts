import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { studios } from '../../src/server/db/schema.js';
import { asSystem } from '../../src/server/db/tenancy.js';
import { boot } from './boot.js';

const slowBody = (parts: string[]) => {
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  const body = new ReadableStream<Uint8Array>({ async start(ctrl) { ctrl.enqueue(new TextEncoder().encode(parts[0]!)); await gate; ctrl.enqueue(new TextEncoder().encode(parts[1]!)); ctrl.close(); } });
  return { body, release };
};

describe('request transaction', () => {
  it('reads the body before opening the transaction, so a slow client never holds the database', async () => {
    const { app, db, signupOwner } = await boot(); const { cookie } = await signupOwner('o@x.com', 'S');
    const { body, release } = slowBody(['{"name":"Slow",', '"emails":[]}']);
    const pending = app.request('/api/clients', { method: 'POST', body, duplex: 'half', headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' } } as RequestInit);
    await new Promise((r) => setTimeout(r, 200)); // let the request reach the handler, which is now waiting on the rest of the body
    const other = await Promise.race([asSystem(db, (tx) => tx.select().from(studios)).then(() => 'free'), new Promise((r) => setTimeout(() => r('blocked'), 1000))]);
    release();
    expect(other).toBe('free');
    expect((await pending).status).toBe(201);
  });
  it('multipart uploads still parse after the early read', async () => {
    const { api, post, json, signupOwner, seedProject } = await boot(); const { cookie } = await signupOwner('o@x.com', 'S');
    const { projectId } = await seedProject(cookie);
    const { token } = await json<{ token: string }>(await post('/api/access/tokens', { name: 'Mac', scope: 'read+write' }, cookie));
    const fd = new FormData(); fd.append('file', new Blob([await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).jpeg().toBuffer()], { type: 'image/jpeg' }), 'f.jpg'); fd.append('uploadId', 'u1');
    expect((await api(`/api/plugin/projects/${projectId}/finals`, { method: 'POST', body: fd, bearer: token })).status).toBe(201);
  });
  it('refuses bodies over 100 MB with 413', async () => {
    const { app, signupOwner } = await boot(); const { cookie } = await signupOwner('o@x.com', 'S');
    const chunk = new Uint8Array(1024 * 1024); let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(ctrl) { if (sent++ > 101) ctrl.close(); else ctrl.enqueue(chunk); } });
    const res = await app.request('/api/clients', { method: 'POST', body, duplex: 'half', headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' } } as RequestInit);
    expect(res.status).toBe(413);
  });
});
