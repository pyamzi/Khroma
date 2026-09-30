import { describe, it, expect } from 'vitest';
import { jobs, studios } from '../../src/server/db/schema.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { sendEmail, makeEmailHandlers } from '../../src/server/email/send.js';
import { getStudio, setStudio, inviteUser, updateUser, removeUser, listUsers, listJobs, retryJobById, TeamError } from '../../src/server/domain/settings.js';
import { studioTestDb, makeStudio } from '../helpers.js';

describe('settings', () => {
  it('studio settings round-trip with defaults; the name lives on the Studio', async () => {
    const { db } = await studioTestDb({ name: 'Lumen' });
    expect(await getStudio(db)).toMatchObject({ studioName: 'Lumen', currency: 'usd', defaultIncluded: 0 });
    await setStudio(db, { studioName: 'Klaus Studio', currency: 'eur', defaultIncluded: 40, timezone: 'Europe/Berlin' }, 'owner@x');
    expect(await getStudio(db)).toMatchObject({ studioName: 'Klaus Studio', currency: 'eur', defaultIncluded: 40, timezone: 'Europe/Berlin' });
    expect((await db.select().from(studios))[0]!.name).toBe('Klaus Studio');
    await expect(setStudio(db, { currency: 'x' }, 'owner@x')).rejects.toThrow();
    await expect(setStudio(db, { studioName: ' ' }, 'owner@x')).rejects.toThrow();
  });
  it('team: invite sends a link, roles guarded, last owner protected, no self-removal', async () => {
    const { db, ownerId: u1 } = await studioTestDb();
    const m = await inviteUser(db, { email: 'Sam@X', role: 'member', actor: 'owner@x', baseUrl: 'https://g' });
    expect(m).toMatchObject({ email: 'sam@x', role: 'member' });
    expect((await db.select().from(jobs)).find((j) => j.kind === 'send_email')?.payload).toMatchObject({ to: 'sam@x', template: 'magic_link', vars: { studio: 'Test Studio' } });
    await expect(inviteUser(db, { email: 'sam@x', role: 'member', actor: 'owner@x', baseUrl: 'https://g' })).rejects.toThrow(TeamError);
    expect(await listUsers(db)).toHaveLength(2);
    await expect(updateUser(db, { userId: u1, patch: { role: 'member' }, actor: 'owner@x' })).rejects.toThrow(/last_owner/);
    await expect(removeUser(db, { userId: u1, actor: 'owner@x' })).rejects.toThrow(/last_owner|self/);
    await updateUser(db, { userId: m.id, patch: { role: 'owner', notifyDownloads: 'each' }, actor: 'owner@x' });
    await updateUser(db, { userId: u1, patch: { role: 'member' }, actor: 'owner@x' });
    await expect(removeUser(db, { userId: m.id, actor: 'sam@x' })).rejects.toThrow(/self/);
    await removeUser(db, { userId: u1, actor: 'sam@x' });
    expect((await listUsers(db)).map((u) => u.email)).toEqual(['sam@x']);
    await expect(removeUser(db, { userId: m.id, actor: 'owner@x' })).rejects.toThrow(/last_owner/);
  });
  it('inviting a Team member of another Studio says exists and reveals nothing', async () => {
    const { db } = await studioTestDb();
    await makeStudio(db, { ownerEmail: 'b-owner@x.com' });
    const err = await inviteUser(db, { email: 'b-owner@x.com', role: 'member', actor: 'owner@x', baseUrl: 'https://g' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamError); expect((err as TeamError).code).toBe('exists');
    expect((await listUsers(db)).map((u) => u.email)).toEqual(['owner@x']);
    expect(await db.select().from(jobs)).toEqual([]);
  });
  it('jobs list and retry', async () => {
    const { db } = await studioTestDb();
    await sendEmail(db, { to: 'a@x', template: 'test_delivery', vars: { studio: 'S' }, key: 't' });
    for (let i = 0; i < 3; i++) await runOnce(db, makeEmailHandlers(() => null, 'g'), Date.now() + i * 3600_000);
    expect(await listJobs(db, { state: 'failed' })).toHaveLength(1);
    const j = (await listJobs(db, { state: 'failed' }))[0]!;
    expect((await retryJobById(db, j.id)).state).toBe('pending');
    await expect(retryJobById(db, j.id)).rejects.toThrow();
    expect(await listJobs(db)).toHaveLength(1);
  });
});
