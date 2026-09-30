import { describe, expect, it } from 'vitest';
import { normalizeLicense, passesFilters, UNKNOWN_LICENSE } from '../src/license';

const flags = (l: ReturnType<typeof normalizeLicense>) =>
  [l.commercial_use, l.modification_allowed, l.attribution_required, l.share_alike];

describe('normalizeLicense: every code in the rules table', () => {
  it.each([
    // raw, code, [commercial, modification, attribution, share_alike]
    ['cc0', 'cc0', [true, true, false, false]],
    ['pdm', 'pdm', [true, true, false, false]],
    ['by', 'cc-by', [true, true, true, false]],
    ['cc-by', 'cc-by', [true, true, true, false]],
    ['by-sa', 'cc-by-sa', [true, true, true, true]],
    ['by-nd', 'cc-by-nd', [true, false, true, false]],
    ['by-nc', 'cc-by-nc', [false, true, true, false]],
    ['by-nc-sa', 'cc-by-nc-sa', [false, true, true, true]],
    ['by-nc-nd', 'cc-by-nc-nd', [false, false, true, false]],
    ['pexels', 'pexels', [true, true, true, false]],
    ['pixabay', 'pixabay', [true, true, false, false]],
  ] as const)('%s -> %s', (raw, code, expected) => {
    const l = normalizeLicense(raw);
    expect(l.code).toBe(code);
    expect(flags(l)).toEqual(expected);
    expect(l.url).toMatch(/^https:\/\//);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeLicense(' BY-SA ').code).toBe('cc-by-sa');
  });

  it('maps unmapped codes to unknown with every flag false', () => {
    for (const raw of ['sampling+', 'nc-sampling+', '', 'wtfpl']) {
      const l = normalizeLicense(raw);
      expect(l).toEqual(UNKNOWN_LICENSE);
      expect(flags(l)).toEqual([false, false, false, false]);
      expect(l.url).toBeNull();
    }
  });

  it('adds the CC version to the name and prefers the provider license URL', () => {
    const l = normalizeLicense('by', { version: '2.0', url: 'https://creativecommons.org/licenses/by/2.0/' });
    expect(l.name).toBe('CC BY 2.0');
    expect(l.url).toBe('https://creativecommons.org/licenses/by/2.0/');
    expect(normalizeLicense('pexels', { version: '2.0' }).name).toBe('Pexels License');
  });
});

describe('passesFilters', () => {
  const on = { commercial_use_only: true, modification_allowed: true };
  const off = { commercial_use_only: false, modification_allowed: false };

  it('keeps commercial + modifiable licenses under default filters', () => {
    for (const c of ['cc0', 'pdm', 'by', 'by-sa', 'pexels', 'pixabay'])
      expect(passesFilters(normalizeLicense(c), on)).toBe(true);
  });

  it('drops NC under commercial_use_only, ND under modification_allowed, unknown under either', () => {
    expect(passesFilters(normalizeLicense('by-nc'), { commercial_use_only: true, modification_allowed: false })).toBe(false);
    expect(passesFilters(normalizeLicense('by-nd'), { commercial_use_only: false, modification_allowed: true })).toBe(false);
    expect(passesFilters(normalizeLicense('by-nd'), { commercial_use_only: true, modification_allowed: false })).toBe(true);
    expect(passesFilters(UNKNOWN_LICENSE, { commercial_use_only: true, modification_allowed: false })).toBe(false);
    expect(passesFilters(UNKNOWN_LICENSE, { commercial_use_only: false, modification_allowed: true })).toBe(false);
  });

  it('lets everything through when both filters are off', () => {
    for (const c of ['by-nc-nd', 'by-nd', 'sampling+'])
      expect(passesFilters(normalizeLicense(c), off)).toBe(true);
  });
});
