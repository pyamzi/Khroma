import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins/magic-link';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { authUsers, authSessions, authAccounts, authVerifications } from '../db/schema.js';
import { renderTemplate } from '../email/templates.js';
import type { Transport } from '../email/transport.js';

/** What the job queue passes through `signInMagicLink`'s `metadata`: everything the mail needs, so no database read happens inside Better Auth. */
export type LinkMeta = { studioId: string; kind: 'admin' | 'client'; fromName: string; replyTo: string | null };

export function createAuth(o: { root: Db; config: Config; getTransport: () => Transport | null }) {
  const { root, config, getTransport } = o;
  const domain = new URL(config.baseUrl).hostname;
  return betterAuth({
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthUrl,
    basePath: '/api/ba',
    database: drizzleAdapter(root, { provider: 'pg', schema: { user: authUsers, session: authSessions, account: authAccounts, verification: authVerifications } }),
    session: { expiresIn: 30 * 86400, additionalFields: { studioId: { type: 'string', required: false, input: false }, kind: { type: 'string', required: false, input: false } } },
    advanced: { cookiePrefix: 'og' },
    plugins: [magicLink({
      expiresIn: 30 * 86400, // the Client maximum; the Team's 15 minutes is enforced when the Studio binding lands
      storeToken: 'hashed',
      async sendMagicLink({ email, url, metadata }) {
        const m = metadata as Partial<LinkMeta> | undefined;
        if (!m?.studioId || !m.kind) throw new Error('sign-in links are sent by the job queue only');
        const transport = getTransport();
        if (!transport) throw new Error('email transport is not configured');
        const fromName = m.fromName ?? 'Khroma';
        await transport.send({ to: email, ...renderTemplate('magic_link', { studio: fromName, url }), messageId: `<magic:${randomUUID()}@${domain}>`, fromName, replyTo: m.replyTo ?? null });
      },
    })],
  });
}
export type Auth = ReturnType<typeof createAuth>;
