import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/server/config.js';

const base = { DATABASE_URL: 'pglite://memory', BASE_URL: 'https://og.example' };
const r2 = { R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk', R2_BUCKET: 'b' };
const prod = { ...base, NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h/db', SMTP_URL: 'smtp://u:p@h:587', ...r2 };

describe('loadConfig', () => {
  it('parses required values and defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ databaseUrl: 'pglite://memory', baseUrl: 'https://og.example', port: 3000, secureCookies: true, emailFrom: 'no-reply@og.example', production: false });
    expect(c.smtpUrl).toBeUndefined(); expect(c.r2).toBeUndefined();
  });
  it('requires a database url', () => { expect(() => loadConfig({ BASE_URL: 'https://og.example' })).toThrow(/DATABASE_URL/); });
  it('turns off secure cookies for http base urls', () => { expect(loadConfig({ ...base, BASE_URL: 'http://localhost:3000/' })).toMatchObject({ secureCookies: false, baseUrl: 'http://localhost:3000' }); });
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
});
