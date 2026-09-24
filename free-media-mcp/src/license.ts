import type { License, LicenseCode } from './types';

const CC = 'https://creativecommons.org';

// Source of truth for the spec's license rules table. Pexels/Pixabay rows come from
// their license pages read on 2026-09-24 (see README "Provider compliance").
const TABLE: Record<Exclude<LicenseCode, 'unknown'>, Omit<License, 'code'>> = {
  cc0:          { name: 'CC0 1.0', url: `${CC}/publicdomain/zero/1.0/`, commercial_use: true, modification_allowed: true, attribution_required: false, share_alike: false },
  pdm:          { name: 'Public Domain Mark 1.0', url: `${CC}/publicdomain/mark/1.0/`, commercial_use: true, modification_allowed: true, attribution_required: false, share_alike: false },
  'cc-by':      { name: 'CC BY', url: `${CC}/licenses/by/4.0/`, commercial_use: true, modification_allowed: true, attribution_required: true, share_alike: false },
  'cc-by-sa':   { name: 'CC BY-SA', url: `${CC}/licenses/by-sa/4.0/`, commercial_use: true, modification_allowed: true, attribution_required: true, share_alike: true },
  'cc-by-nd':   { name: 'CC BY-ND', url: `${CC}/licenses/by-nd/4.0/`, commercial_use: true, modification_allowed: false, attribution_required: true, share_alike: false },
  'cc-by-nc':   { name: 'CC BY-NC', url: `${CC}/licenses/by-nc/4.0/`, commercial_use: false, modification_allowed: true, attribution_required: true, share_alike: false },
  'cc-by-nc-sa': { name: 'CC BY-NC-SA', url: `${CC}/licenses/by-nc-sa/4.0/`, commercial_use: false, modification_allowed: true, attribution_required: true, share_alike: true },
  'cc-by-nc-nd': { name: 'CC BY-NC-ND', url: `${CC}/licenses/by-nc-nd/4.0/`, commercial_use: false, modification_allowed: false, attribution_required: true, share_alike: false },
  pexels:       { name: 'Pexels License', url: 'https://www.pexels.com/license/', commercial_use: true, modification_allowed: true, attribution_required: true, share_alike: false },
  pixabay:      { name: 'Pixabay Content License', url: 'https://pixabay.com/service/license-summary/', commercial_use: true, modification_allowed: true, attribution_required: false, share_alike: false },
};

export const UNKNOWN_LICENSE: License = {
  code: 'unknown', name: 'Unknown license', url: null,
  commercial_use: false, modification_allowed: false, attribution_required: false, share_alike: false,
};

/** Accepts Openverse codes ("by", "by-nc-sa", "cc0", "pdm"), our own ("cc-by"), and provider ids ("pexels", "pixabay"). */
export function normalizeLicense(raw: string, opts: { version?: string | null; url?: string | null } = {}): License {
  const key = raw.trim().toLowerCase();
  const code = key in TABLE ? key : `cc-${key}`;
  const row = TABLE[code as keyof typeof TABLE];
  if (!row) return UNKNOWN_LICENSE;
  const isCc = code.startsWith('cc-');
  return {
    code: code as LicenseCode,
    ...row,
    name: isCc && opts.version ? `${row.name} ${opts.version}` : row.name,
    url: opts.url ?? row.url,
  };
}

export function passesFilters(l: License, f: { commercial_use_only: boolean; modification_allowed: boolean }): boolean {
  if (f.commercial_use_only && !l.commercial_use) return false;
  if (f.modification_allowed && !l.modification_allowed) return false;
  return true;
}
