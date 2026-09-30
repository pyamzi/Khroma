import { withAttribution } from '../attribution';
import { cached } from '../cache';
import type { Env } from '../env';
import { fetchJson, HttpError } from '../http';
import { normalizeLicense } from '../license';
import { SOURCE_NAMES, type MediaResult, type Provider, type SearchQuery, type SourceId } from '../types';

const API = 'https://api.openverse.org/v1';
export const OPENVERSE_TTL = 3600;

export interface OvImage {
  id: string;
  title: string | null;
  creator: string | null;
  creator_url: string | null;
  url: string;
  thumbnail: string;
  foreign_landing_url: string;
  source: string;
  license: string;
  license_version: string | null;
  license_url: string | null;
  width: number | null;
  height: number | null;
}

const ASPECT = { landscape: 'wide', portrait: 'tall', square: 'square' } as const;
const OWN_SOURCES = ['wikimedia', 'flickr'] as const satisfies readonly SourceId[];

// ponytail: names only the Sources we filter on; any other Openverse source is title-cased from its id.
const sourceName = (id: string) =>
  SOURCE_NAMES[id as SourceId] ?? id.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export function mapOpenverse(i: OvImage): MediaResult {
  return withAttribution({
    id: `openverse:${i.id}`,
    provider: 'openverse',
    media_type: 'image',
    title: i.title || null,
    creator: i.creator || null,
    creator_url: i.creator_url || null,
    source_page_url: i.foreign_landing_url,
    preview_url: i.thumbnail,
    full_url: i.url,
    width: i.width ?? null,
    height: i.height ?? null,
    duration_seconds: null,
    source: sourceName(i.source),
    license: normalizeLicense(i.license, { version: i.license_version, url: i.license_url }),
  });
}

/** Anonymous Openverse is 20/min, 200/day per IP and Workers egress IPs are shared; a registered app lifts that. */
async function authHeaders(env: Env): Promise<Record<string, string>> {
  const { OPENVERSE_CLIENT_ID: id, OPENVERSE_CLIENT_SECRET: secret } = env;
  if (!id || !secret) return {};
  let token = await env.MEDIA_CACHE.get<string>('v1:openverse:token', 'json');
  if (!token) {
    const t = await fetchJson<{ access_token: string; expires_in: number }>(`${API}/auth_tokens/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }).toString(),
    });
    token = t.access_token;
    await env.MEDIA_CACHE.put('v1:openverse:token', JSON.stringify(token), { expirationTtl: Math.max(60, t.expires_in - 300) });
  }
  return { Authorization: `Bearer ${token}` };
}

export const openverse: Provider = {
  id: 'openverse',
  supports: ['image'],
  sources: OWN_SOURCES,

  async search(q: SearchQuery, env: Env) {
    const p = new URLSearchParams({ q: q.query.slice(0, 200), page_size: String(q.limit), mature: 'false' });
    if (q.orientation !== 'any') p.set('aspect_ratio', ASPECT[q.orientation]);
    const types = [q.commercial_use_only && 'commercial', q.modification_allowed && 'modification'].filter(Boolean);
    if (types.length) p.set('license_type', types.join(','));
    const own = (q.sources ?? []).filter((s) => (OWN_SOURCES as readonly string[]).includes(s));
    if (own.length) p.set('source', own.join(','));
    const url = `${API}/images/?${p}`;
    const data = await cached(env.MEDIA_CACHE, url, OPENVERSE_TTL, async () =>
      fetchJson<{ results: OvImage[] }>(url, { headers: await authHeaders(env) }),
    );
    return data.results.map(mapOpenverse);
  },

  async get(nativeId: string, env: Env) {
    const url = `${API}/images/${encodeURIComponent(nativeId)}/`;
    try {
      const i = await cached(env.MEDIA_CACHE, url, OPENVERSE_TTL, async () => fetchJson<OvImage>(url, { headers: await authHeaders(env) }));
      const r = mapOpenverse(i);
      return {
        ...r,
        renditions: [
          { label: 'thumbnail', url: i.thumbnail, width: null, height: null },
          { label: 'full', url: i.url, width: r.width, height: r.height },
        ],
      };
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  },
};
