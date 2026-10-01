import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/server/config.js';

const base = { DATABASE_URL: 'pglite://memory', BASE_URL: 'https://og.example' };
const r2 = { R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk', R2_BUCKET: 'b' };
const prod = { ...base, NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h/db', SMTP_URL: 'smtp://u:p@h:587', BETTER_AUTH_SECRET: 'p'.repeat(40), ...r2 };

describe('loadConfig', () => {
  it('parses required values and defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ databaseUrl: 'pglite://memory', baseUrl: 'https://og.example', port: 3000, emailFrom: 'no-reply@og.example', production: false });
    expect(c.smtpUrl).toBeUndefined(); expect(c.r2).toBeUndefined();
  });
  it('requires a database url', () => { expect(() => loadConfig({ BASE_URL: 'https://og.example' })).toThrow(/DATABASE_URL/); });
  it('drops a trailing slash from BASE_URL', () => { expect(loadConfig({ ...base, BASE_URL: 'http://localhost:3000/' }).baseUrl).toBe('http://localhost:3000'); });
  it('R2 variables are all or none', () => {
    expect(loadConfig({ ...base, ...r2 }).r2).toEqual({ accountId: 'acc', accessKeyId: 'ak', secretAccessKey: 'sk', bucket: 'b' });
    expect(() => loadConfig({ ...base, R2_BUCKET: 'b' })).toThrow(/R2_ACCOUNT_ID/);
  });
  it('production requires SMTP and R2 and rejects PGlite', () => {
    expect(loadConfig(prod)).toMatchObject({ production: true, smtpUrl: 'smtp://u:p@h:587' });
    const { R2_ACCOUNT_ID: _a, R2_ACCESS_KEY_ID: _b, R2_SECRET_ACCESS_KEY: _c, R2_BUCKET: _d, ...noR2 } = prod;
    expect(() => loadConfig(noR2)).toThrow(/R2_ACCOUNT_ID/);
    expect(() => loadConfig({ ...prod, SMTP_URL: undefined })).toThrow(/SMTP_URL/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: 'pglite://memory' })).toThrow(/pglite/i);
  });
  it('RESEND_API_KEY alone is enough for email (pasted key may carry whitespace)', () => {
    const c = loadConfig({ ...prod, SMTP_URL: undefined, RESEND_API_KEY: ' re_abc_123\n' });
    expect(c.smtpUrl).toBe('smtp://resend:re_abc_123@smtp.resend.com:587');
  });
  it('production needs a 32-character BETTER_AUTH_SECRET', () => {
    expect(() => loadConfig({ ...prod, BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET is required in production/);
    expect(() => loadConfig({ ...prod, BETTER_AUTH_SECRET: undefined })).toThrow(/BETTER_AUTH_SECRET is required in production/);
    expect(loadConfig({ ...prod, BETTER_AUTH_SECRET: 'x'.repeat(32) }).betterAuthUrl).toBe('https://og.example');
  });
  it('production needs BETTER_AUTH_URL on the same https origin as BASE_URL', () => {
    expect(loadConfig({ ...prod, BETTER_AUTH_URL: 'https://og.example/' }).betterAuthUrl).toBe('https://og.example');
    expect(() => loadConfig({ ...prod, BETTER_AUTH_URL: 'https://other.example' })).toThrow(/BETTER_AUTH_URL/);
    expect(() => loadConfig({ ...prod, BETTER_AUTH_URL: 'http://localhost:3000' })).toThrow(/BETTER_AUTH_URL/);
    expect(() => loadConfig({ ...prod, BASE_URL: 'http://og.example' })).toThrow(/https/);
  });
  it('dev and tests default to a fixed 32+ character secret and the base url', () => {
    const c = loadConfig({ ...base, BASE_URL: 'http://localhost:3000/' });
    expect(c.betterAuthSecret.length).toBeGreaterThanOrEqual(32);
    expect(c.betterAuthUrl).toBe('http://localhost:3000');
    expect(loadConfig({ ...base, BETTER_AUTH_SECRET: 'y'.repeat(40), BETTER_AUTH_URL: 'https://auth.example' })).toMatchObject({ betterAuthSecret: 'y'.repeat(40), betterAuthUrl: 'https://auth.example' });
  });
  it('remote processing needs both FLY_API_TOKEN and FLY_APP_NAME', () => {
    expect(loadConfig(prod).processing).toEqual({ mode: 'local' });
    expect(loadConfig({ ...prod, FLY_API_TOKEN: 'tok' }).processing).toEqual({ mode: 'local' });
    expect(loadConfig({ ...prod, FLY_APP_NAME: 'og' }).processing).toEqual({ mode: 'local' }); // Fly sets the name on every machine
    expect(loadConfig({ ...prod, FLY_API_TOKEN: 'tok', FLY_APP_NAME: 'og' }).processing).toEqual({ mode: 'remote', appName: 'og', token: 'tok' });
    expect(loadConfig({ ...base, FLY_API_TOKEN: ' tok\n', FLY_APP_NAME: 'og' }).processing).toMatchObject({ mode: 'remote', token: 'tok' });
  });
});
