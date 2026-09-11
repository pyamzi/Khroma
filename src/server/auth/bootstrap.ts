import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { getSetting, setSetting, deleteSetting } from '../db/settings.js';
import { createMagicLink, hashToken, randomToken } from './magic.js';
import { sendEmail } from '../email/send.js';
import type { EmailConfig } from '../email/transport.js';
import { newId } from '../fs/ids.js';

type SetupToken = { hash: string; expiresAt: number };
const SETUP_TTL = 15 * 60_000;

/** Setup is complete only once the owner has redeemed a real magic link, proving email works. */
export function setupState(db: Db): 'unconfigured' | 'awaiting_verification' | 'complete' {
  if (getSetting<boolean>(db, 'setup.complete')) return 'complete';
  return db.select({ id: users.id }).from(users).get() ? 'awaiting_verification' : 'unconfigured';
}
export function markSetupComplete(db: Db): void { setSetting(db, 'setup.complete', true); }

/** Printed by the local CLI; never exposed over HTTP. */
export function createSetupToken(db: Db, now = Date.now()): string {
  if (setupState(db) === 'complete') throw new Error('setup is already complete');
  const token = randomToken();
  setSetting(db, 'setup.token', { hash: hashToken(token), expiresAt: now + SETUP_TTL } satisfies SetupToken);
  return token;
}

export function completeSetup(db: Db, o: { token: string; ownerEmail: string; studioName: string; email: EmailConfig; baseUrl: string; now?: number }): { ok: true } | { ok: false; error: string } {
  const now = o.now ?? Date.now();
  const t = getSetting<SetupToken>(db, 'setup.token');
  if (!t || t.hash !== hashToken(o.token)) return { ok: false, error: 'invalid setup token' };
  if (t.expiresAt <= now) return { ok: false, error: 'setup token expired; run setup-token again' };
  const email = o.ownerEmail.trim().toLowerCase();
  db.transaction((tx) => {
    const d = tx as unknown as Db;
    deleteSetting(d, 'setup.token');
    const id = newId();
    tx.insert(users).values({ id, email, role: 'owner' }).onConflictDoNothing().run();
    setSetting(d, 'studioName', o.studioName); setSetting(d, 'email', o.email);
    const link = createMagicLink(d, { kind: 'admin', email, now });
    sendEmail(d, { to: email, template: 'magic_link', vars: { studio: o.studioName, url: `${o.baseUrl}/auth/${link.token}` }, key: `setup:${id}:${now}` });
  });
  return { ok: true };
}
