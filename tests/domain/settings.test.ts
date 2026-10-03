import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { users, jobs, settings } from '../../src/server/db/schema.js';
import { loadConfig } from '../../src/server/config.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { makeEmailHandlers } from '../../src/server/email/send.js';
import { memoryTransport } from '../../src/server/email/transport.js';
import { getStudio, setStudio, setEmailConfig, emailStatus, sendDeliveryTest, inviteUser, updateUser, removeUser, listUsers, listJobs, retryJobById, TeamError } from '../../src/server/domain/settings.js';

const config = loadConfig({ DATA_DIR: '/tmp/x', PHOTOS_DIR: '/tmp/y', BASE_URL: 'https://g.example', SESSION_SECRET: 'x'.repeat(32) });
function fresh() { const db = openDb(':memory:'); migrate(db); db.insert(users).values({ id: 'u1', email: 'owner@x', role: 'owner' }).run(); return db; }

describe('settings', () => {
  it('studio settings round-trip with defaults', () => {
    const db = fresh();
    expect(getStudio(db)).toMatchObject({ studioName: 'OpenGallery', currency: 'usd', defaultIncluded: 0 });
    setStudio(db, { studioName: 'Klaus Studio', currency: 'eur', defaultIncluded: 40, timezone: 'Europe/Berlin' }, 'owner@x');
    expect(getStudio(db)).toMatchObject({ studioName: 'Klaus Studio', currency: 'eur', defaultIncluded: 40, timezone: 'Europe/Berlin' });
    expect(() => setStudio(db, { currency: 'x' }, 'owner@x')).toThrow();
  });
  it('email config, status, and a delivery test that reports the job state', async () => {
    const db = fresh();
    expect(emailStatus(db, config)).toMatchObject({ configured: false, lastTest: null });
    setEmailConfig(db, { type: 'smtp', url: 'smtp://u:p@h:587', from: 'S <s@x>' }, config.sessionSecret, 'owner@x');
    expect(JSON.stringify(db.select().from(settings).all())).not.toContain('smtp://u:p@h'); // encrypted at rest
    expect(emailStatus(db, config)).toMatchObject({ configured: true, describe: 'smtp h:587' });
    const { jobId } = sendDeliveryTest(db, { to: 'owner@x', actor: 'owner@x' });
    expect(emailStatus(db, config).lastTest).toMatchObject({ jobId, state: 'pending' });
    const t = memoryTransport(); await runOnce(db, makeEmailHandlers(() => t, 'g'));
    expect(emailStatus(db, config).lastTest).toMatchObject({ jobId, state: 'done' });
    expect(t.sent[0]).toMatchObject({ to: 'owner@x', subject: expect.stringContaining('email delivery works') });
    const { jobId: j2 } = sendDeliveryTest(db, { to: 'owner@x', actor: 'owner@x' });
    await runOnce(db, makeEmailHandlers(() => null, 'g'));
    expect(emailStatus(db, config).lastTest).toMatchObject({ jobId: j2, state: 'pending', lastError: expect.stringContaining('no email transport') });
  });
  it('team: invite sends a link, roles guarded, last owner protected, no self-removal', () => {
    const db = fresh();
    const m = inviteUser(db, { email: 'Sam@X', role: 'member', actor: 'owner@x', baseUrl: 'https://g', studio: 'S' });
    expect(m).toMatchObject({ email: 'sam@x', role: 'member' });
    expect(db.select().from(jobs).all().find((j) => j.kind === 'send_email')?.payload).toMatchObject({ to: 'sam@x', template: 'magic_link' });
    expect(() => inviteUser(db, { email: 'sam@x', role: 'member', actor: 'owner@x', baseUrl: 'https://g', studio: 'S' })).toThrow(TeamError);
    expect(listUsers(db)).toHaveLength(2);
    expect(() => updateUser(db, { userId: 'u1', patch: { role: 'member' }, actor: 'owner@x' })).toThrow(/last_owner/);
    expect(() => removeUser(db, { userId: 'u1', actor: 'owner@x' })).toThrow(/last_owner|self/);
    updateUser(db, { userId: m.id, patch: { role: 'owner', notifyDownloads: 'each' }, actor: 'owner@x' });
    updateUser(db, { userId: 'u1', patch: { role: 'member' }, actor: 'owner@x' });
    expect(() => removeUser(db, { userId: m.id, actor: 'sam@x' })).toThrow(/self/);
    removeUser(db, { userId: 'u1', actor: 'sam@x' });
    expect(listUsers(db).map((u) => u.email)).toEqual(['sam@x']);
    expect(() => removeUser(db, { userId: m.id, actor: 'owner@x' })).toThrow(/last_owner/);
  });
  it('jobs list and retry', async () => {
    const db = fresh();
    sendDeliveryTest(db, { to: 'a@x', actor: 'owner@x' });
    for (let i = 0; i < 3; i++) await runOnce(db, makeEmailHandlers(() => null, 'g'), Date.now() + i * 3600_000);
    expect(listJobs(db, { state: 'failed' })).toHaveLength(1);
    const j = listJobs(db, { state: 'failed' })[0]!;
    expect(retryJobById(db, j.id).state).toBe('pending');
    expect(() => retryJobById(db, j.id)).toThrow();
    expect(listJobs(db)).toHaveLength(1);
  });
});
