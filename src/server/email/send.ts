import type { Db } from '../db/client.js';
import { enqueue, type Handlers } from '../jobs/queue.js';
import { renderTemplate, type TemplateName } from './templates.js';
import type { Transport } from './transport.js';

/** Queue an email; `key` is the logical notification identity, so a retry never becomes a second message. */
export function sendEmail(db: Db, o: { to: string; template: TemplateName; vars: Record<string, string>; key: string }): void {
  enqueue(db, { kind: 'send_email', payload: o, idempotencyKey: `email:${o.key}` });
}

export function makeEmailHandlers(getTransport: () => Transport | null, domain: string): Handlers {
  return {
    send_email: async (payload) => {
      const o = payload as { to: string; template: TemplateName; vars: Record<string, string>; key: string };
      const t = getTransport(); if (!t) throw new Error('no email transport configured');
      const r = renderTemplate(o.template, o.vars);
      await t.send({ to: o.to, ...r, messageId: `<email:${o.key}@${domain}>` });
    },
  };
}
