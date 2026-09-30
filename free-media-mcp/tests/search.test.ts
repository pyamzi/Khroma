import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredProviders, getMedia, interleave, matchesOrientation, parseId, searchMedia } from '../src/search';
import { OV_IMAGE, OV_IMAGE_NC, PB_IMAGE, PX_PHOTO, PX_VIDEO } from './fixtures';
import { fakeEnv, jsonResponse, stubFetch, type Route } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const input = { query: 'golden hour wedding couple', media_type: 'image' as const, commercial_use_only: true, modification_allowed: true, orientation: 'any' as const, limit: 8 };

const allOk = (): Record<string, Route> => ({
  'api.openverse.org': () => jsonResponse({ results: [OV_IMAGE, OV_IMAGE_NC, { ...OV_IMAGE, id: 'ov3', title: 'third' }] }),
  'api.pexels.com': (url) => jsonResponse(url.pathname.startsWith('/videos') ? { videos: [PX_VIDEO] } : { photos: [PX_PHOTO, { ...PX_PHOTO, id: 2 }] }),
  'pixabay.com': () => jsonResponse({ hits: [PB_IMAGE] }),
});

describe('configuredProviders', () => {
  it('always includes Openverse; Pexels/Pixabay only with keys', () => {
    expect(configuredProviders(fakeEnv()).map((p) => p.id)).toEqual(['openverse', 'pexels', 'pixabay']);
    expect(configuredProviders(fakeEnv({ PEXELS_API_KEY: undefined, PIXABAY_API_KEY: undefined })).map((p) => p.id)).toEqual(['openverse']);
  });
});

describe('searchMedia', () => {
  it('queries providers in parallel (all requests in flight before any resolves)', async () => {
    // Each provider awaits a KV read and a SHA-256 before fetching, so the start ORDER is not deterministic.
    // Every route serves its own correct body and all three block on one shared gate.
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const body: Record<string, unknown> = {
      'api.openverse.org': { results: [OV_IMAGE] },
      'api.pexels.com': { photos: [PX_PHOTO] },
      'pixabay.com': { hits: [PB_IMAGE] },
    };
    const routes: Record<string, Route> = Object.fromEntries(
      Object.keys(body).map((host) => [host, async () => { started.push(host); await gate; return jsonResponse(body[host]); }]),
    );
    stubFetch(routes);
    const promise = searchMedia(input, fakeEnv());
    await vi.waitFor(() => expect(started).toHaveLength(3));
    release();
    const out = await promise;
    expect(out.results).toHaveLength(3);
    expect(out.warnings).toEqual([]);
  });

  it('interleaves providers, filters NC after normalization, respects limit', async () => {
    stubFetch(allOk());
    const out = await searchMedia({ ...input, limit: 4 }, fakeEnv());
    expect(out.results.map((r) => r.id)).toEqual(['openverse:575fdc8f-9f62-431c-a24d-9717001ff2ba', 'pexels:2014422', 'pixabay:195893', 'openverse:ov3']);
    expect(out.results.some((r) => r.license.code === 'cc-by-nc')).toBe(false);
  });

  it('one provider erroring (HTTP 429) still returns the others plus a warning', async () => {
    stubFetch({ ...allOk(), 'api.pexels.com': () => jsonResponse({ error: 'limit' }, 429) });
    const out = await searchMedia(input, fakeEnv());
    expect(out.results.map((r) => r.provider)).toEqual(['openverse', 'pixabay', 'openverse']);
    expect(out.warnings).toEqual(['pexels: HTTP 429 from api.pexels.com']);
  });

  it('a non-JSON provider body becomes a warning, not a failure', async () => {
    stubFetch({ ...allOk(), 'pixabay.com': () => new Response('<html>', { status: 200 }) });
    const out = await searchMedia(input, fakeEnv());
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/^pixabay: /);
  });

  it('video queries never touch Openverse', async () => {
    const { calls } = stubFetch(allOk());
    const out = await searchMedia({ ...input, media_type: 'video' }, fakeEnv());
    expect(calls.map((u) => u.hostname)).not.toContain('api.openverse.org');
    expect(out.results.map((r) => r.id)).toEqual(['pexels:video:2499611']);
  });

  it('providers filter: unknown/unsupported/unconfigured entries warn; none left -> empty results', async () => {
    const { calls } = stubFetch(allOk());
    const out = await searchMedia({ ...input, media_type: 'video', providers: ['openverse', 'pixabay'] }, fakeEnv({ PIXABAY_API_KEY: undefined }));
    expect(calls).toHaveLength(0);
    expect(out.results).toEqual([]);
    expect(out.warnings).toEqual(['openverse: not configured or does not support video', 'pixabay: not configured or does not support video', 'no providers available for this query']);
  });

  it('orientation is enforced on every provider by dimensions (square Pixabay result kept, landscape dropped)', async () => {
    stubFetch({ ...allOk(), 'pixabay.com': () => jsonResponse({ hits: [PB_IMAGE, { ...PB_IMAGE, id: 7, imageWidth: 1000, imageHeight: 1000 }] }) });
    const out = await searchMedia({ ...input, orientation: 'square', providers: ['pixabay'] }, fakeEnv());
    expect(out.results.map((r) => r.id)).toEqual(['pixabay:7']);
  });

  it('sources: ["wikimedia"] queries only Openverse, with the Commons filter', async () => {
    const { calls } = stubFetch(allOk());
    const out = await searchMedia({ ...input, sources: ['wikimedia'] }, fakeEnv());
    expect(calls.map((u) => u.hostname)).toEqual(['api.openverse.org']);
    expect(calls[0]!.searchParams.get('source')).toBe('wikimedia');
    expect(out.warnings).toEqual([]);
  });

  it('sources: ["pexels"] never touches Openverse or Pixabay', async () => {
    const { calls } = stubFetch(allOk());
    await searchMedia({ ...input, sources: ['pexels'] }, fakeEnv());
    expect(calls.map((u) => u.hostname)).toEqual(['api.pexels.com']);
  });

  it('a requested Source no active provider can search is a warning, not a throw', async () => {
    const { calls } = stubFetch(allOk());
    const out = await searchMedia({ ...input, media_type: 'video', sources: ['wikimedia'] }, fakeEnv());
    expect(calls).toHaveLength(0);
    expect(out.results).toEqual([]);
    expect(out.warnings).toEqual(['wikimedia: no configured provider searches this source for video', 'no providers available for this query']);
  });

  it('trims the query before use', async () => {
    const { calls } = stubFetch(allOk());
    await searchMedia({ ...input, query: '  sunset  ', providers: ['openverse'] }, fakeEnv());
    expect(calls[0]!.searchParams.get('q')).toBe('sunset');
  });
});

describe('helpers', () => {
  it('interleave round-robins and stops at limit', () => {
    expect(interleave<number | string>([[1, 2, 3], ['a'], ['x', 'y']], 5)).toEqual([1, 'a', 'x', 2, 'y']);
    expect(interleave([[], []], 3)).toEqual([]);
  });

  it('matchesOrientation', () => {
    expect(matchesOrientation(1920, 1080, 'landscape')).toBe(true);
    expect(matchesOrientation(1080, 1920, 'landscape')).toBe(false);
    expect(matchesOrientation(1000, 1030, 'square')).toBe(true);
    expect(matchesOrientation(null, null, 'portrait')).toBe(true);
    expect(matchesOrientation(1, 2, 'any')).toBe(true);
  });

  it('parseId splits on the first colon and rejects garbage', () => {
    expect(parseId('pexels:video:12')).toEqual({ provider: 'pexels', nativeId: 'video:12' });
    expect(parseId('openverse:abc')).toEqual({ provider: 'openverse', nativeId: 'abc' });
    for (const bad of ['abc', 'unsplash:1', 'pexels:', ':1', ''])
      expect(parseId(bad)).toBeNull();
  });
});

describe('getMedia', () => {
  it('routes to the provider and returns renditions', async () => {
    stubFetch({ 'api.pexels.com': () => jsonResponse(PX_PHOTO) });
    const r = await getMedia('pexels:2014422', fakeEnv());
    expect(r.renditions?.length).toBe(8);
  });

  it('readable errors for bad id, unconfigured provider, and not found', async () => {
    stubFetch({ 'api.openverse.org': () => jsonResponse({}, 404) });
    await expect(getMedia('nope', fakeEnv())).rejects.toThrow('invalid id "nope", expected "provider:native_id"');
    await expect(getMedia('pixabay:1', fakeEnv({ PIXABAY_API_KEY: undefined }))).rejects.toThrow('pixabay is not configured');
    await expect(getMedia('openverse:missing', fakeEnv())).rejects.toThrow('openverse:missing not found');
  });
});
