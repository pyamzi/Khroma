import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { studios, users } from '../db/schema.js';
import { enqueue, type Handlers } from '../jobs/queue.js';
import { renderTemplate, type TemplateName } from './templates.js';
import type { Transport } from './transport.js';
import { createMagicLink } from '../auth/magic.js';

type EmailJob = { to: string; template: TemplateName; vars: Record<string, string>; key: string; magic?: { kind: 'admin' | 'client'; baseUrl: string } };

/** Queue an email; `key` is the logical notification identity, so a retry never becomes a second message. Pass `studioId` from a system transaction. */
export async function sendEmail(db: Db, o: EmailJob & { studioId?: string }): Promise<void> {
  const { studioId, ...payload } = o;
  await enqueue(db, { kind: 'send_email', payload, idempotencyKey: `email:${o.key}`, studioId });
}

export function makeEmailHandlers(getTransport: () => Transport | null, domain: string): Handlers {
  return {
    send_email: async (payload, ctx) => {
      const o = payload as EmailJob;
      const t = getTransport(); if (!t) throw new Error('no email transport configured');
      const [studio] = await ctx.db.select({ name: studios.name, confirmedAt: studios.confirmedAt }).from(studios).where(eq(studios.id, ctx.studioId)).limit(1);
      const [owner] = await ctx.db.select({ email: users.email }).from(users).where(and(eq(users.studioId, ctx.studioId), eq(users.role, 'owner'))).orderBy(asc(users.createdAt)).limit(1);
      const vars = { ...o.vars };
      if (o.magic) vars.url = `${o.magic.baseUrl}/auth/${(await createMagicLink(ctx.db, { kind: o.magic.kind, email: o.to, studioId: ctx.studioId })).token}`; // rolled back with the job if sending fails
      const r = renderTemplate(o.template, vars);
      await t.send({ to: o.to, ...r, messageId: `<email:${o.key}@${domain}>`, fromName: studio?.confirmedAt ? studio.name : 'OpenGallery', replyTo: owner?.email ?? null });
    },
  };
}
