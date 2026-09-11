import { z } from 'zod';

const Env = z.object({
  DATA_DIR: z.string().min(1),
  PHOTOS_DIR: z.string().min(1),
  BASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(3000),
  SMTP_URL: z.string().url().optional(),
  LISTMONK_URL: z.string().url().optional(),
  LISTMONK_TOKEN: z.string().optional(),
});

export type Config = {
  dataDir: string; photosDir: string; baseUrl: string; sessionSecret: string; port: number;
  smtpUrl?: string; listmonkUrl?: string; listmonkToken?: string; secureCookies: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const e = Env.parse(env);
  return {
    dataDir: e.DATA_DIR, photosDir: e.PHOTOS_DIR, baseUrl: e.BASE_URL.replace(/\/$/, ''),
    sessionSecret: e.SESSION_SECRET, port: e.PORT, smtpUrl: e.SMTP_URL,
    listmonkUrl: e.LISTMONK_URL, listmonkToken: e.LISTMONK_TOKEN,
    secureCookies: e.BASE_URL.startsWith('https://'),
  };
}
