import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { openDb, migrate } from '../../src/server/db/client.js';
import { jobs } from '../../src/server/db/schema.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { renderTemplate } from '../../src/server/email/templates.js';
import { memoryTransport, listmonkTransport } from '../../src/server/email/transport.js';
import { sendEmail, makeEmailHandlers } from '../../src/server/email/send.js';

describe('email', () => {
  it('renders the magic link template with escaping', () => {
    const r = renderTemplate('magic_link', { studio: 'Test <Studio>', url: 'https://g/x/abc' });
    expect(r.subject).toContain('Test <Studio>'); expect(r.text).toContain('https://g/x/abc');
    expect(r.html).toContain('href="https://g/x/abc"'); expect(r.html).toContain('Test &lt;Studio&gt;');
  });
  it('sends through a job with a stable message id and dedups by key', async () => {
    const db = openDb(':memory:'); migrate(db); const t = memoryTransport();
    sendEmail(db, { to: 'a@x', template: 'test_delivery', vars: { studio: 'S' }, key: 'test:1' });
    sendEmail(db, { to: 'a@x', template: 'test_delivery', vars: { studio: 'S' }, key: 'test:1' });
    expect(db.select().from(jobs).all()).toHaveLength(1);
    await runOnce(db, makeEmailHandlers(() => t, 'g.example'));
    expect(t.sent).toHaveLength(1); expect(t.sent[0]?.messageId).toBe('<email:test:1@g.example>');
  });
  it('fails the job visibly when no transport is configured', async () => {
    const db = openDb(':memory:'); migrate(db);
    sendEmail(db, { to: 'a@x', template: 'test_delivery', vars: { studio: 'S' }, key: 'k' });
    await runOnce(db, makeEmailHandlers(() => null, 'g'));
    const row = db.select().from(jobs).get()!;
    expect(row.state).toBe('pending'); expect(row.lastError).toMatch(/no email transport/);
  });
  it('posts to the listmonk tx api', async () => {
    const bodies: unknown[] = [];
    const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { bodies.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{"data":true}'); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as { port: number }).port;
    try {
      const t = listmonkTransport(`http://127.0.0.1:${port}`, 'tok', 'S <s@x>', 7);
      await t.send({ to: 'a@x', subject: 'Hi', text: 'T', html: '<p>T</p>', messageId: '<m@x>' });
      expect(bodies[0]).toMatchObject({ url: '/api/tx', auth: 'token tok', body: { subscriber_email: 'a@x', template_id: 7, data: { subject: 'Hi', html: '<p>T</p>', text: 'T' } } });
    } finally { srv.close(); }
  });
});
