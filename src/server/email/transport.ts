import nodemailer from 'nodemailer';
import type { Db } from '../db/client.js';
import { getSetting } from '../db/settings.js';
import type { Config } from '../config.js';

export type Mail = { to: string; subject: string; text: string; html: string; messageId: string };
export interface Transport { send(m: Mail): Promise<void>; describe(): string }
export type EmailConfig =
  | { type: 'smtp'; url: string; from: string }
  | { type: 'listmonk'; url: string; token: string; from: string; templateId: number };

export function smtpTransport(url: string, from: string): Transport {
  const t = nodemailer.createTransport(url);
  return {
    describe: () => `smtp ${new URL(url).host}`,
    async send(m) { await t.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html, messageId: m.messageId }); },
  };
}

export function listmonkTransport(url: string, token: string, from: string, templateId: number): Transport {
  return {
    describe: () => `listmonk ${url}`,
    async send(m) {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/tx`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `token ${token}` },
        body: JSON.stringify({ subscriber_email: m.to, template_id: templateId, from_email: from, headers: [{ 'Message-ID': m.messageId }], data: { subject: m.subject, html: m.html, text: m.text } }),
      });
      if (!res.ok) throw new Error(`listmonk tx failed: ${res.status} ${await res.text()}`);
    },
  };
}

export function memoryTransport(): Transport & { sent: Mail[] } {
  const sent: Mail[] = [];
  return { sent, describe: () => 'memory', async send(m) { sent.push(m); } };
}

/** Settings win over environment. Null means no transport is configured. */
export function resolveTransport(db: Db, config: Config): Transport | null {
  const s = getSetting<EmailConfig>(db, 'email');
  if (s?.type === 'smtp') return smtpTransport(s.url, s.from);
  if (s?.type === 'listmonk') return listmonkTransport(s.url, s.token, s.from, s.templateId);
  if (config.smtpUrl) return smtpTransport(config.smtpUrl, `OpenGallery <no-reply@${new URL(config.baseUrl).hostname}>`);
  return null;
}
