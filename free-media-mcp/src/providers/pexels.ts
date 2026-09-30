import { withAttribution } from '../attribution';
import { cached } from '../cache';
import type { Env } from '../env';
import { fetchJson, HttpError } from '../http';
import { normalizeLicense } from '../license';
import type { MediaResult, Provider, Rendition, SearchQuery } from '../types';

const API = 'https://api.pexels.com';
export const PEXELS_TTL = 3600;

export interface PxPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt: string | null;
  src: Record<'original' | 'large2x' | 'large' | 'medium' | 'small' | 'portrait' | 'landscape' | 'tiny', string>;
}

export interface PxVideoFile {
  quality: string;
  file_type: string;
  width: number | null;
  height: number | null;
  link: string;
}

export interface PxVideo {
  id: number;
  width: number;
  height: number;
  url: string;
  image: string;
  duration: number;
  user: { name: string; url: string };
  video_files: PxVideoFile[];
}

const mp4s = (v: PxVideo) =>
  v.video_files.filter((f) => f.file_type === 'video/mp4' && f.width !== null).sort((a, b) => (b.width ?? 0) - (a.width ?? 0));

export function mapPexelsPhoto(p: PxPhoto): MediaResult {
  return withAttribution({
    id: `pexels:${p.id}`,
    provider: 'pexels',
    media_type: 'image',
    title: p.alt || null,
    creator: p.photographer,
    creator_url: p.photographer_url,
    source_page_url: p.url,
    preview_url: p.src.medium,
    full_url: p.src.original,
    width: p.width,
    height: p.height,
    duration_seconds: null,
    source: 'Pexels',
    license: normalizeLicense('pexels'),
  });
}

export function mapPexelsVideo(v: PxVideo): MediaResult | null {
  const best = mp4s(v)[0];
  if (!best) return null;
  return withAttribution({
    id: `pexels:video:${v.id}`,
    provider: 'pexels',
    media_type: 'video',
    title: null,
    creator: v.user.name,
    creator_url: v.user.url,
    source_page_url: v.url,
    preview_url: v.image,
    full_url: best.link,
    width: v.width,
    height: v.height,
    duration_seconds: v.duration,
    source: 'Pexels',
    license: normalizeLicense('pexels'),
  });
}

const photoRenditions = (p: PxPhoto): Rendition[] =>
  (Object.keys(p.src) as (keyof PxPhoto['src'])[]).map((label) => ({
    label,
    url: p.src[label],
    width: label === 'original' ? p.width : null,
    height: label === 'original' ? p.height : null,
  }));

const videoRenditions = (v: PxVideo): Rendition[] =>
  mp4s(v).map((f) => ({ label: `${f.quality} ${f.width}x${f.height}`, url: f.link, width: f.width, height: f.height }));

const headers = (env: Env) => ({ Authorization: env.PEXELS_API_KEY ?? '' });

export const pexels: Provider = {
  id: 'pexels',
  supports: ['image', 'video'],
  sources: ['pexels'],

  async search(q: SearchQuery, env: Env) {
    const p = new URLSearchParams({ query: q.query, per_page: String(q.limit) });
    if (q.orientation !== 'any') p.set('orientation', q.orientation);
    if (q.media_type === 'video') {
      const url = `${API}/videos/search?${p}`;
      const d = await cached(env.MEDIA_CACHE, url, PEXELS_TTL, () => fetchJson<{ videos: PxVideo[] }>(url, { headers: headers(env) }));
      return d.videos.map(mapPexelsVideo).filter((r): r is MediaResult => r !== null);
    }
    const url = `${API}/v1/search?${p}`;
    const d = await cached(env.MEDIA_CACHE, url, PEXELS_TTL, () => fetchJson<{ photos: PxPhoto[] }>(url, { headers: headers(env) }));
    return d.photos.map(mapPexelsPhoto);
  },

  async get(nativeId: string, env: Env) {
    const video = nativeId.startsWith('video:');
    const num = video ? nativeId.slice('video:'.length) : nativeId;
    if (!/^\d+$/.test(num)) return null;
    try {
      if (video) {
        const url = `${API}/videos/videos/${num}`;
        const v = await cached(env.MEDIA_CACHE, url, PEXELS_TTL, () => fetchJson<PxVideo>(url, { headers: headers(env) }));
        const r = mapPexelsVideo(v);
        return r && { ...r, renditions: videoRenditions(v) };
      }
      const url = `${API}/v1/photos/${num}`;
      const p = await cached(env.MEDIA_CACHE, url, PEXELS_TTL, () => fetchJson<PxPhoto>(url, { headers: headers(env) }));
      return { ...mapPexelsPhoto(p), renditions: photoRenditions(p) };
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  },
};
