import { z } from 'zod';

const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;
const Env = z.object({
  DATABASE_URL: z.string({ required_error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
  BASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  SMTP_URL: z.string().url().optional(),
  RESEND_API_KEY: z.string().trim().min(1).optional(), // shorthand for Resend's SMTP_URL
  EMAIL_FROM: z.string().email().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  NODE_ENV: z.string().optional(),
  R2_ACCOUNT_ID: z.string().min(1).optional(), R2_ACCESS_KEY_ID: z.string().min(1).optional(), R2_SECRET_ACCESS_KEY: z.string().min(1).optional(), R2_BUCKET: z.string().min(1).optional(),
});

const DEV_AUTH_SECRET = 'opengallery-dev-only-auth-secret-0123456789'; // 32+ chars; never used in production

export type Config = {
  databaseUrl: string; baseUrl: string; port: number; smtpUrl?: string; emailFrom: string; production: boolean; secureCookies: boolean;
  betterAuthSecret: string; betterAuthUrl: string;
  r2?: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  const e = Env.parse(env);
  const production = e.NODE_ENV === 'production';
  const setR2 = R2_KEYS.filter((k) => e[k]);
  if ((setR2.length > 0 || production) && setR2.length < R2_KEYS.length) throw new Error(`missing ${R2_KEYS.filter((k) => !e[k]).join(', ')}`);
  const smtpUrl = e.RESEND_API_KEY ? `smtp://resend:${encodeURIComponent(e.RESEND_API_KEY)}@smtp.resend.com:587` : e.SMTP_URL;
  if (production && !smtpUrl) throw new Error('SMTP_URL or RESEND_API_KEY is required in production');
  if (production && e.DATABASE_URL.startsWith('pglite:')) throw new Error('pglite is for tests and local dev, not production');
  if (production && (e.BETTER_AUTH_SECRET ?? '').length < 32) throw new Error('BETTER_AUTH_SECRET is required in production');
  const baseUrl = e.BASE_URL.replace(/\/$/, '');
  return {
    databaseUrl: e.DATABASE_URL, baseUrl, port: e.PORT, smtpUrl, emailFrom: e.EMAIL_FROM ?? `no-reply@${new URL(baseUrl).hostname}`,
    production, secureCookies: baseUrl.startsWith('https://'),
    betterAuthSecret: e.BETTER_AUTH_SECRET || DEV_AUTH_SECRET, betterAuthUrl: e.BETTER_AUTH_URL?.replace(/\/$/, '') ?? baseUrl,
    r2: setR2.length ? { accountId: e.R2_ACCOUNT_ID!, accessKeyId: e.R2_ACCESS_KEY_ID!, secretAccessKey: e.R2_SECRET_ACCESS_KEY!, bucket: e.R2_BUCKET! } : undefined,
  };
}
