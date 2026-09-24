import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapPexelsPhoto, mapPexelsVideo, pexels } from '../src/providers/pexels';
import { PX_PHOTO, PX_VIDEO } from './fixtures';
import { fakeEnv, jsonResponse, stubFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const q = { query: 'golden hour wedding couple', media_type: 'image' as const, orientation: 'portrait' as const, limit: 5, commercial_use_only: true, modification_allowed: true };

describe('mapping', () => {
  it('photo: alt as title, original as full, medium as preview, pexels license', () => {
    expect(mapPexelsPhoto(PX_PHOTO)).toMatchObject({
      id: 'pexels:2014422', provider: 'pexels', media_type: 'image', title: 'Brown Rocks During Golden Hour',
      creator: 'Joey Farina', creator_url: 'https://www.pexels.com/@joey', source_page_url: PX_PHOTO.url,
      preview_url: PX_PHOTO.src.medium, full_url: PX_PHOTO.src.original, width: 3024, height: 3024, duration_seconds: null,
      license: { code: 'pexels', attribution_required: true, commercial_use: true },
      attribution_text: 'Photo by Joey Farina on Pexels (https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/)',
    });
  });

  it('video: largest mp4 as full, poster image as preview, video: id prefix, duration', () => {
    expect(mapPexelsVideo(PX_VIDEO)).toMatchObject({
      id: 'pexels:video:2499611', media_type: 'video', title: null, creator: 'Joey Farina',
      preview_url: PX_VIDEO.image, full_url: 'https://player.vimeo.com/external/hd.mp4', width: 1080, height: 1920, duration_seconds: 22,
    });
  });

  it('video without any video/mp4 file is dropped (null)', () => {
    expect(mapPexelsVideo({ ...PX_VIDEO, video_files: [{ ...PX_VIDEO.video_files[2]!, file_type: 'application/x-mpegURL' }] })).toBeNull();
  });
});

describe('pexels.search', () => {
  it('images: /v1/search with Authorization, query, per_page, orientation', async () => {
    const { calls, fn } = stubFetch({ 'api.pexels.com': () => jsonResponse({ photos: [PX_PHOTO] }) });
    const out = await pexels.search(q, fakeEnv());
    expect(out.map((r) => r.id)).toEqual(['pexels:2014422']);
    expect(calls[0]!.pathname).toBe('/v1/search');
    expect(calls[0]!.searchParams.get('query')).toBe('golden hour wedding couple');
    expect(calls[0]!.searchParams.get('per_page')).toBe('5');
    expect(calls[0]!.searchParams.get('orientation')).toBe('portrait');
    expect(((fn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).Authorization).toBe('pexels-test-key');
  });

  it('videos: /videos/search, drops items without mp4', async () => {
    stubFetch({ 'api.pexels.com': () => jsonResponse({ videos: [PX_VIDEO, { ...PX_VIDEO, id: 9, video_files: [] }] }) });
    const out = await pexels.search({ ...q, media_type: 'video', orientation: 'any' }, fakeEnv());
    expect(out.map((r) => r.id)).toEqual(['pexels:video:2499611']);
  });
});

describe('pexels.get', () => {
  it('photo id -> /v1/photos/:id with all src renditions', async () => {
    const { calls } = stubFetch({ 'api.pexels.com': () => jsonResponse(PX_PHOTO) });
    const r = await pexels.get('2014422', fakeEnv());
    expect(calls[0]!.pathname).toBe('/v1/photos/2014422');
    expect(r?.renditions?.map((x) => x.label)).toEqual(['original', 'large2x', 'large', 'medium', 'small', 'portrait', 'landscape', 'tiny']);
    expect(r?.renditions?.[0]).toEqual({ label: 'original', url: PX_PHOTO.src.original, width: 3024, height: 3024 });
  });

  it('video:id -> /videos/videos/:id with one rendition per mp4 file', async () => {
    const { calls } = stubFetch({ 'api.pexels.com': () => jsonResponse(PX_VIDEO) });
    const r = await pexels.get('video:2499611', fakeEnv());
    expect(calls[0]!.pathname).toBe('/videos/videos/2499611');
    expect(r?.renditions).toEqual([
      { label: 'hd 1080x1920', url: 'https://player.vimeo.com/external/hd.mp4', width: 1080, height: 1920 },
      { label: 'sd 540x960', url: 'https://player.vimeo.com/external/sd.mp4', width: 540, height: 960 },
    ]);
  });

  it('non-numeric ids never reach the network; 404 -> null', async () => {
    const { fn } = stubFetch({ 'api.pexels.com': () => jsonResponse({}, 404) });
    expect(await pexels.get('../etc', fakeEnv())).toBeNull();
    expect(await pexels.get('video:abc', fakeEnv())).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(await pexels.get('1', fakeEnv())).toBeNull();
  });
});
