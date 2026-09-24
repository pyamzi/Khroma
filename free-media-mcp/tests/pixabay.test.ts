import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheKey } from '../src/cache';
import { mapPixabayImage, mapPixabayVideo, pixabay, PIXABAY_TTL } from '../src/providers/pixabay';
import { PB_IMAGE, PB_VIDEO } from './fixtures';
import { fakeEnv, jsonResponse, stubFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const q = { query: 'blossom', media_type: 'image' as const, orientation: 'landscape' as const, limit: 2, commercial_use_only: true, modification_allowed: true };

describe('mapping', () => {
  it('image: largeImageURL as full (scaled dims), webformat as preview, no title, user page as creator_url', () => {
    expect(mapPixabayImage(PB_IMAGE)).toMatchObject({
      id: 'pixabay:195893', provider: 'pixabay', media_type: 'image', title: null, creator: 'Josch13',
      creator_url: 'https://pixabay.com/users/Josch13-48777/', source_page_url: PB_IMAGE.pageURL,
      preview_url: PB_IMAGE.webformatURL, full_url: PB_IMAGE.largeImageURL, width: 1280, height: 720,
      license: { code: 'pixabay', attribution_required: false, commercial_use: true },
      attribution_text: 'Image by Josch13 from Pixabay (https://pixabay.com/en/blossom-bloom-flower-195893/)',
    });
  });

  it('image: prefers imageURL, then fullHDURL, with their real dimensions', () => {
    expect(mapPixabayImage({ ...PB_IMAGE, imageURL: 'https://x/full.jpg' })).toMatchObject({ full_url: 'https://x/full.jpg', width: 4000, height: 2250 });
    expect(mapPixabayImage({ ...PB_IMAGE, fullHDURL: 'https://x/hd.jpg' })).toMatchObject({ full_url: 'https://x/hd.jpg', width: 1920, height: 1080 });
  });

  it('video: large as full, falls back to the next non-empty size, dropped when all empty', () => {
    expect(mapPixabayVideo(PB_VIDEO)).toMatchObject({
      id: 'pixabay:video:125', media_type: 'video', full_url: PB_VIDEO.videos.large.url, width: 1920, height: 1080,
      preview_url: PB_VIDEO.videos.medium.thumbnail, duration_seconds: 12, creator: 'Coverr-Free-Footage',
    });
    const noLarge = { ...PB_VIDEO, videos: { ...PB_VIDEO.videos, large: { ...PB_VIDEO.videos.large, url: '' } } };
    expect(mapPixabayVideo(noLarge)).toMatchObject({ full_url: PB_VIDEO.videos.medium.url, width: 1280, height: 720 });
    const empty = { ...PB_VIDEO, videos: Object.fromEntries(Object.entries(PB_VIDEO.videos).map(([k, v]) => [k, { ...v, url: '' }])) as typeof PB_VIDEO.videos };
    expect(mapPixabayVideo(empty)).toBeNull();
  });
});

describe('pixabay.search', () => {
  it('images: key, q (≤100 chars), per_page ≥ 3, orientation=horizontal, safesearch', async () => {
    const { calls } = stubFetch({ 'pixabay.com': () => jsonResponse({ hits: [PB_IMAGE] }) });
    await pixabay.search({ ...q, query: 'y'.repeat(150) }, fakeEnv());
    const url = calls[0]!;
    expect(url.pathname).toBe('/api/');
    expect(url.searchParams.get('key')).toBe('pixabay-test-key');
    expect(url.searchParams.get('q')).toHaveLength(100);
    expect(url.searchParams.get('per_page')).toBe('3');
    expect(url.searchParams.get('orientation')).toBe('horizontal');
    expect(url.searchParams.get('safesearch')).toBe('true');
  });

  it('videos: /api/videos/ without orientation; square sends no orientation', async () => {
    const { calls } = stubFetch({ 'pixabay.com': (url) => jsonResponse({ hits: url.pathname === '/api/videos/' ? [PB_VIDEO] : [PB_IMAGE] }) });
    const out = await pixabay.search({ ...q, media_type: 'video', orientation: 'portrait' }, fakeEnv());
    expect(out.map((r) => r.id)).toEqual(['pixabay:video:125']);
    expect(calls[0]!.pathname).toBe('/api/videos/');
    expect(calls[0]!.searchParams.get('orientation')).toBeNull();
    await pixabay.search({ ...q, orientation: 'square' }, fakeEnv());
    expect(calls[1]!.searchParams.get('orientation')).toBeNull();
  });

  it('caches for 24 h under a key that excludes the API key', async () => {
    stubFetch({ 'pixabay.com': () => jsonResponse({ hits: [PB_IMAGE] }) });
    const env = fakeEnv();
    const put = vi.spyOn(env.MEDIA_CACHE, 'put');
    await pixabay.search(q, env);
    expect(put).toHaveBeenCalledWith(expect.any(String), expect.any(String), { expirationTtl: PIXABAY_TTL });
    // The key is the hash of the request URL *without* the key param (param order as built by the provider).
    expect(put.mock.calls[0]![0]).toBe(await cacheKey('https://pixabay.com/api/?q=blossom&per_page=3&safesearch=true&orientation=horizontal'));
  });
});

describe('pixabay.get', () => {
  it('image and video by id param; empty hits -> null; non-numeric never fetches', async () => {
    const { calls, fn } = stubFetch({ 'pixabay.com': (url) => jsonResponse({ hits: url.pathname === '/api/videos/' ? [PB_VIDEO] : [] }) });
    expect(await pixabay.get('195893', fakeEnv())).toBeNull();
    expect(calls[0]!.searchParams.get('id')).toBe('195893');
    const v = await pixabay.get('video:125', fakeEnv());
    expect(calls[1]!.pathname).toBe('/api/videos/');
    expect(v?.renditions).toEqual([
      { label: 'large', url: PB_VIDEO.videos.large.url, width: 1920, height: 1080 },
      { label: 'medium', url: PB_VIDEO.videos.medium.url, width: 1280, height: 720 },
      { label: 'small', url: PB_VIDEO.videos.small.url, width: 640, height: 360 },
      { label: 'tiny', url: PB_VIDEO.videos.tiny.url, width: 480, height: 270 },
    ]);
    expect(await pixabay.get('x;drop', fakeEnv())).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('image renditions list preview, webformat, large (and hd/full when present)', async () => {
    stubFetch({ 'pixabay.com': () => jsonResponse({ hits: [{ ...PB_IMAGE, fullHDURL: 'https://x/hd.jpg' }] }) });
    const r = await pixabay.get('195893', fakeEnv());
    expect(r?.renditions).toEqual([
      { label: 'preview', url: PB_IMAGE.previewURL, width: 150, height: 84 },
      { label: 'webformat', url: PB_IMAGE.webformatURL, width: 640, height: 360 },
      { label: 'large', url: PB_IMAGE.largeImageURL, width: 1280, height: 720 },
      { label: 'fullhd', url: 'https://x/hd.jpg', width: 1920, height: 1080 },
    ]);
  });
});
