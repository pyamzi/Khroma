import { describe, it, expect } from 'vitest';
import { limited, _hits } from '../../src/server/http/routes/auth.js';

describe('sign-in rate limit', () => {
  it('limits per key and keeps the map bounded', () => {
    const T0 = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) expect(limited('e:a@x', 5, T0)).toBe(false);
    expect(limited('e:a@x', 5, T0)).toBe(true);
    expect(limited('e:a@x', 5, T0 + 16 * 60_000)).toBe(false); // window rolled
    for (let i = 0; i < 6000; i++) limited(`e:${i}@x`, 5, T0); // one attacker, many addresses
    expect(_hits.size).toBeLessThanOrEqual(5001);
    limited('e:late@x', 5, T0 + 20 * 60_000); // expired keys are swept once the window has passed
    expect(_hits.size).toBeLessThan(100);
  });
});
