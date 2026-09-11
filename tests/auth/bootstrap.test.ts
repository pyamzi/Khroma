import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { users, jobs } from '../../src/server/db/schema.js';
import { getSetting } from '../../src/server/db/settings.js';
import { createSetupToken, completeSetup, setupState, markSetupComplete } from '../../src/server/auth/bootstrap.js';

const T0 = 1_700_000_000_000; const email = { type: 'smtp' as const, url: 'smtp://u:p@h:587', from: 'S <s@x>' };
function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

describe('bootstrap', () => {
  it('walks unconfigured → awaiting_verification → complete', () => {
    const db = fresh(); expect(setupState(db)).toBe('unconfigured');
    const token = createSetupToken(db, T0);
    const r = completeSetup(db, { token, ownerEmail: 'Owner@X.com', studioName: 'S', email, baseUrl: 'https://g', now: T0 + 1000 });
    expect(r.ok).toBe(true);
    expect(setupState(db)).toBe('awaiting_verification');
    expect(db.select().from(users).get()).toMatchObject({ email: 'owner@x.com', role: 'owner' });
    expect(getSetting(db, 'email')).toEqual(email);
    expect(getSetting(db, 'setup.token')).toBeNull();
    const job = db.select().from(jobs).get()!; expect(job.kind).toBe('send_email');
    expect((job.payload as { vars: { url: string } }).vars.url).toMatch(/^https:\/\/g\/auth\//);
    markSetupComplete(db); expect(setupState(db)).toBe('complete');
  });
  it('rejects a wrong, expired, or reused token', () => {
    const db = fresh(); const token = createSetupToken(db, T0);
    expect(completeSetup(db, { token: 'nope', ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 }).ok).toBe(false);
    expect(completeSetup(db, { token, ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 + 16 * 60_000 }).ok).toBe(false);
    const t2 = createSetupToken(db, T0);
    expect(completeSetup(db, { token, ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 }).ok).toBe(false); // superseded
    expect(completeSetup(db, { token: t2, ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 }).ok).toBe(true);
    expect(completeSetup(db, { token: t2, ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 }).ok).toBe(false);
  });
  it('refuses new setup tokens once complete', () => {
    const db = fresh(); const token = createSetupToken(db, T0);
    completeSetup(db, { token, ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 }); markSetupComplete(db);
    expect(() => createSetupToken(db, T0)).toThrow(/complete/);
  });
});
