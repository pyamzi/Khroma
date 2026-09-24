import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapOpenverse, openverse } from '../src/providers/openverse';
import { OV_IMAGE } from './fixtures';
import { fakeEnv, jsonResponse, stubFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const q = { query: 'golden hour wedding couple', media_type: 'image' as const, orientation: 'landscape' as const, limit: 8, commercial_use_only: true, modification_allowed: true };

describe('mapOpenverse', () => {
  it('maps fields, id prefix, license with version and provider URL', () => {
    const r = mapOpenverse(OV_IMAGE);
    expect(r).toMatchObject({
      id: 'openverse:575fdc8f-9f62-431c-a24d-9717001ff2ba', provider: 'openverse', media_type: 'image',
      title: 'Bride and groom in Hanoi', creator: 'PiktourUK', creator_url: OV_IMAGE.creator_url,
      source_page_url: OV_IMAGE.foreign_landing_url, preview_url: OV_IMAGE.thumbnail, full_url: OV_IMAGE.url,
      width: 1024, height: 837, duration_seconds: null,
      license: { code: 'cc-by', name: 'CC BY 2.0', url: OV_IMAGE.license_url, attribution_required: true },
    });
    expect(r.attribution_text).toContain('is licensed under CC BY 2.0');
  });
});

describe('openverse.search', () => {
  it('sends q, page_size, aspect_ratio, license_type and mature=false, anonymously by default', async () => {
    const { calls, fn } = stubFetch({ 'api.openverse.org': () => jsonResponse({ results: [OV_IMAGE] }) });
    const out = await openverse.search(q, fakeEnv());
    expect(out).toHaveLength(1);
    const url = calls[0]!;
    expect(url.pathname).toBe('/v1/images/');
    expect(url.searchParams.get('q')).toBe('golden hour wedding couple');
    expect(url.searchParams.get('page_size')).toBe('8');
    expect(url.searchParams.get('aspect_ratio')).toBe('wide');
    expect(url.searchParams.get('license_type')).toBe('commercial,modification');
    expect(url.searchParams.get('mature')).toBe('false');
    const headers = (fn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('omits aspect_ratio for "any" and license_type when both filters are off, clamps q to 200 chars', async () => {
    const { calls } = stubFetch({ 'api.openverse.org': () => jsonResponse({ results: [] }) });
    await openverse.search({ ...q, query: 'x'.repeat(300), orientation: 'any', commercial_use_only: false, modification_allowed: false }, fakeEnv());
    expect(calls[0]!.searchParams.get('aspect_ratio')).toBeNull();
    expect(calls[0]!.searchParams.get('license_type')).toBeNull();
    expect(calls[0]!.searchParams.get('q')).toHaveLength(200);
  });

  it('fetches a bearer token once when client credentials are set, and caches it', async () => {
    const { calls, fn } = stubFetch({
      'api.openverse.org': (url) =>
        url.pathname === '/v1/auth_tokens/token/'
          ? jsonResponse({ access_token: 'tok', expires_in: 43200, token_type: 'Bearer', scope: 'read' })
          : jsonResponse({ results: [OV_IMAGE] }),
    });
    const env = fakeEnv({ OPENVERSE_CLIENT_ID: 'id', OPENVERSE_CLIENT_SECRET: 'sec' });
    await openverse.search(q, env);
    await openverse.search({ ...q, query: 'other' }, env);
    const tokenCalls = calls.filter((u) => u.pathname === '/v1/auth_tokens/token/');
    expect(tokenCalls).toHaveLength(1);
    const tokenInit = fn.mock.calls[0]![1] as RequestInit;
    expect(tokenInit.method).toBe('POST');
    expect((tokenInit.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(String(tokenInit.body)).toBe('client_id=id&client_secret=sec&grant_type=client_credentials');
    const searchInit = fn.mock.calls[1]![1] as RequestInit;
    expect((searchInit.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('serves an identical search from KV without a second fetch', async () => {
    const { fn } = stubFetch({ 'api.openverse.org': () => jsonResponse({ results: [OV_IMAGE] }) });
    const env = fakeEnv();
    await openverse.search(q, env);
    await openverse.search(q, env);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('openverse.get', () => {
  it('returns the item with thumbnail and full renditions', async () => {
    const { calls } = stubFetch({ 'api.openverse.org': () => jsonResponse(OV_IMAGE) });
    const r = await openverse.get(OV_IMAGE.id, fakeEnv());
    expect(calls[0]!.pathname).toBe(`/v1/images/${OV_IMAGE.id}/`);
    expect(r?.renditions).toEqual([
      { label: 'thumbnail', url: OV_IMAGE.thumbnail, width: null, height: null },
      { label: 'full', url: OV_IMAGE.url, width: 1024, height: 837 },
    ]);
  });

  it('returns null on 404 and rethrows other errors', async () => {
    stubFetch({ 'api.openverse.org': () => jsonResponse({ detail: 'Not found.' }, 404) });
    expect(await openverse.get('missing', fakeEnv())).toBeNull();
    vi.unstubAllGlobals();
    stubFetch({ 'api.openverse.org': () => jsonResponse({}, 500) });
    await expect(openverse.get('boom', fakeEnv())).rejects.toThrow('HTTP 500');
  });
});
