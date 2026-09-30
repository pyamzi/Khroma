import { describe, it, expect } from 'vitest';
import { jobs } from '../../src/server/db/schema.js';
import { asSystem, withStudio } from '../../src/server/db/tenancy.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { renderTemplate } from '../../src/server/email/templates.js';
import { memoryTransport, smtpTransport } from '../../src/server/email/transport.js';
import { sendEmail, makeEmailHandlers } from '../../src/server/email/send.js';
import { testDb, makeStudio } from '../helpers.js';

describe('email', () => {
  it('renders the magic link template with escaping', () => {
    const r = renderTemplate('magic_link', { studio: 'Test <Studio>', url: 'https://g/x/abc' });
    expect(r.subject).toContain('Test <Studio>'); expect(r.text).toContain('https://g/x/abc');
    expect(r.html).toContain('href="https://g/x/abc"'); expect(r.html).toContain('Test &lt;Studio&gt;');
  });
  it('sends through a job with a stable message id and dedups by key', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db); const t = memoryTransport();
    await withStudio(db, studioId, (tx) => sendEmail(tx, { to: 'a@x', template: 'test_delivery', vars: { studio: 'S' }, key: 'test:1' }));
    await withStudio(db, studioId, (tx) => sendEmail(tx, { to: 'a@x', template: 'test_delivery', vars: { studio: 'S' }, key: 'test:1' }));
    expect(await asSystem(db, (tx) => tx.select().from(jobs))).toHaveLength(1);
    await runOnce(db, makeEmailHandlers(() => t, 'g.example'));
    expect(t.sent).toHaveLength(1); expect(t.sent[0]?.messageId).toBe('<email:test:1@g.example>');
  });
  it('sends as the Studio: its name as display name, its first owner as reply-to', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db, { name: 'Lumen Photo', ownerEmail: 'own@x.com' }); const t = memoryTransport();
    await asSystem(db, (tx) => sendEmail(tx, { to: 'c@x', template: 'test_delivery', vars: { studio: 'Lumen Photo' }, key: 'k', studioId }));
    await runOnce(db, makeEmailHandlers(() => t, 'g'));
    expect(t.sent[0]).toMatchObject({ to: 'c@x', fromName: 'Lumen Photo', replyTo: 'own@x.com' });
  });
  it('fails the job visibly when no transport is configured', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db);
    await withStudio(db, studioId, (tx) => sendEmail(tx, { to: 'a@x', template: 'test_delivery', vars: { studio: 'S' }, key: 'k' }));
    await runOnce(db, makeEmailHandlers(() => null, 'g'));
    const [row] = await asSystem(db, (tx) => tx.select().from(jobs));
    expect(row!.state).toBe('pending'); expect(row!.lastError).toMatch(/no email transport/);
  });
  it('smtp transport describes its host', () => {
    expect(smtpTransport('smtp://u:p@h:587', 'no-reply@og.example').describe()).toBe('smtp h:587');
  });
});
