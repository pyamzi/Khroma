import { z } from 'zod';

const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;
const Env = z.object({
  DATABASE_URL: z.string({ required_error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
  BASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  SMTP_URL: z.string().url().optional(),
  EMAIL_FROM: z.string().email().optional(),
  NODE_ENV: z.string().optional(),
  R2_ACCOUNT_ID: z.string().min(1).optional(), R2_ACCESS_KEY_ID: z.string().min(1).optional(), R2_SECRET_ACCESS_KEY: z.string().min(1).optional(), R2_BUCKET: z.string().min(1).optional(),
});

export type Config = {
  databaseUrl: string; baseUrl: string; port: number; smtpUrl?: string; emailFrom: string; production: boolean; secureCookies: boolean;
  r2?: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  const e = Env.parse(env);
  const production = e.NODE_ENV === 'production';
  const setR2 = R2_KEYS.filter((k) => e[k]);
  if ((setR2.length > 0 || production) && setR2.length < R2_KEYS.length) throw new Error(`missing ${R2_KEYS.filter((k) => !e[k]).join(', ')}`);
  if (production && !e.SMTP_URL) throw new Error('SMTP_URL is required in production');
  if (production && e.DATABASE_URL.startsWith('pglite:')) throw new Error('pglite is for tests and local dev, not production');
  const baseUrl = e.BASE_URL.replace(/\/$/, '');
  return {
    databaseUrl: e.DATABASE_URL, baseUrl, port: e.PORT, smtpUrl: e.SMTP_URL, emailFrom: e.EMAIL_FROM ?? `no-reply@${new URL(baseUrl).hostname}`,
    production, secureCookies: baseUrl.startsWith('https://'),
    r2: setR2.length ? { accountId: e.R2_ACCOUNT_ID!, accessKeyId: e.R2_ACCESS_KEY_ID!, secretAccessKey: e.R2_SECRET_ACCESS_KEY!, bucket: e.R2_BUCKET! } : undefined,
  };
}
