import { withAttribution } from '../attribution';
import { cached } from '../cache';
import type { Env } from '../env';
import { fetchJson, HttpError } from '../http';
import { normalizeLicense } from '../license';
import type { MediaResult, Provider, Rendition, SearchQuery } from '../types';

const API = 'https://pixabay.com/api';
/** Pixabay API terms: "requests must be cached for 24 hours". */
export const PIXABAY_TTL = 86400;

export interface PbImage {
  id: number;
  pageURL: string;
  previewURL: string;
  previewWidth: number;
  previewHeight: number;
  webformatURL: string;
  webformatWidth: number;
  webformatHeight: number;
  largeImageURL: string;
  fullHDURL?: string;
  imageURL?: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
  user_id: number;
}

export interface PbVideoFile {
  url: string;
  width: number;
  height: number;
  thumbnail: string;
}

export interface PbVideo {
  id: number;
  pageURL: string;
  duration: number;
  videos: Record<'large' | 'medium' | 'small' | 'tiny', PbVideoFile>;
  user: string;
  user_id: number;
}

const userUrl = (h: { user: string; user_id: number }) => `https://pixabay.com/users/${h.user}-${h.user_id}/`;

/** Pixabay's derived sizes are the original scaled so the longer edge equals `max`. */
const scaled = (w: number, h: number, max: number) => {
  const f = max / Math.max(w, h);
  return { width: Math.round(w * f), height: Math.round(h * f) };
};

function imageRenditions(h: PbImage): Rendition[] {
  const out: Rendition[] = [
    { label: 'preview', url: h.previewURL, width: h.previewWidth, height: h.previewHeight },
    { label: 'webformat', url: h.webformatURL, width: h.webformatWidth, height: h.webformatHeight },
    { label: 'large', url: h.largeImageURL, ...scaled(h.imageWidth, h.imageHeight, 1280) },
  ];
  if (h.fullHDURL) out.push({ label: 'fullhd', url: h.fullHDURL, ...scaled(h.imageWidth, h.imageHeight, 1920) });
  if (h.imageURL) out.push({ label: 'original', url: h.imageURL, width: h.imageWidth, height: h.imageHeight });
  return out;
}

export function mapPixabayImage(h: PbImage): MediaResult {
  const full = imageRenditions(h).at(-1)!; // best available; fullHD/original need "full API access"
  return withAttribution({
    id: `pixabay:${h.id}`,
    provider: 'pixabay',
    media_type: 'image',
    title: null,
    creator: h.user,
    creator_url: userUrl(h),
    source_page_url: h.pageURL,
    preview_url: h.webformatURL,
    full_url: full.url,
    width: full.width,
    height: full.height,
    duration_seconds: null,
    source: 'Pixabay',
    license: normalizeLicense('pixabay'),
  });
}

const videoRenditions = (v: PbVideo): Rendition[] =>
  (['large', 'medium', 'small', 'tiny'] as const)
    .filter((k) => v.videos[k].url)
    .map((k) => ({ label: k, url: v.videos[k].url, width: v.videos[k].width, height: v.videos[k].height }));

export function mapPixabayVideo(v: PbVideo): MediaResult | null {
  const best = videoRenditions(v)[0];
  if (!best) return null;
  return withAttribution({
    id: `pixabay:video:${v.id}`,
    provider: 'pixabay',
    media_type: 'video',
    title: null,
    creator: v.user,
    creator_url: userUrl(v),
    source_page_url: v.pageURL,
    preview_url: v.videos.medium.thumbnail || v.videos.tiny.thumbnail,
    full_url: best.url,
    width: best.width,
    height: best.height,
    duration_seconds: v.duration,
    source: 'Pixabay',
    license: normalizeLicense('pixabay'),
  });
}

const ORIENTATION = { landscape: 'horizontal', portrait: 'vertical' } as const;

/** Builds the URL twice: the cache key must not contain the API key. */
async function hits<T>(env: Env, path: '/' | '/videos/', params: URLSearchParams): Promise<T[]> {
  const keySource = `${API}${path}?${params}`;
  params.set('key', env.PIXABAY_API_KEY ?? '');
  const url = `${API}${path}?${params}`;
  return (await cached(env.MEDIA_CACHE, keySource, PIXABAY_TTL, () => fetchJson<{ hits: T[] }>(url))).hits;
}

export const pixabay: Provider = {
  id: 'pixabay',
  supports: ['image', 'video'],
  sources: ['pixabay'],

  async search(q: SearchQuery, env: Env) {
    const p = new URLSearchParams({ q: q.query.slice(0, 100), per_page: String(Math.max(3, q.limit)), safesearch: 'true' });
    if (q.media_type === 'video') return (await hits<PbVideo>(env, '/videos/', p)).map(mapPixabayVideo).filter((r): r is MediaResult => r !== null);
    if (q.orientation === 'landscape' || q.orientation === 'portrait') p.set('orientation', ORIENTATION[q.orientation]);
    return (await hits<PbImage>(env, '/', p)).map(mapPixabayImage);
  },

  async get(nativeId: string, env: Env) {
    const video = nativeId.startsWith('video:');
    const num = video ? nativeId.slice('video:'.length) : nativeId;
    if (!/^\d+$/.test(num)) return null;
    try {
      const p = new URLSearchParams({ id: num });
      if (video) {
        const v = (await hits<PbVideo>(env, '/videos/', p))[0];
        const r = v && mapPixabayVideo(v);
        return r ? { ...r, renditions: videoRenditions(v) } : null;
      }
      const h = (await hits<PbImage>(env, '/', p))[0];
      return h ? { ...mapPixabayImage(h), renditions: imageRenditions(h) } : null;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 404)) return null; // Pixabay answers 400 for unknown ids
      throw e;
    }
  },
};
