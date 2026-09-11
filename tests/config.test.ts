import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/server/config.js';

const base = { DATA_DIR: '/tmp/d', PHOTOS_DIR: '/tmp/p', BASE_URL: 'https://g.example', SESSION_SECRET: 'x'.repeat(32) };

describe('loadConfig', () => {
  it('parses required values and defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.secureCookies).toBe(true);
    expect(c.smtpUrl).toBeUndefined();
  });
  it('rejects a short session secret', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
  it('turns off secure cookies for http base urls', () => {
    expect(loadConfig({ ...base, BASE_URL: 'http://localhost:3000' }).secureCookies).toBe(false);
  });
});
