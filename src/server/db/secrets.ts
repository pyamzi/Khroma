import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Db } from './client.js';
import { getSetting, setSetting } from './settings.js';

/** Settings that hold credentials are encrypted with a key derived from SESSION_SECRET, which lives only in .env. */
const keyFor = (secret: string) => scryptSync(secret, 'opengallery-settings-v1', 32);

export function encryptJson(value: unknown, secret: string): string {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}
export function decryptJson<T>(blob: string, secret: string): T {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unrecognised secret format');
  const d = createDecipheriv('aes-256-gcm', keyFor(secret), Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')) as T;
}
export function setSecretSetting(db: Db, key: string, value: unknown, secret: string): void { setSetting(db, key, { enc: encryptJson(value, secret) }); }
export function getSecretSetting<T>(db: Db, key: string, secret: string): T | null {
  const row = getSetting<{ enc?: string }>(db, key); if (!row?.enc) return null;
  try { return decryptJson<T>(row.enc, secret); } catch { return null; }
}
