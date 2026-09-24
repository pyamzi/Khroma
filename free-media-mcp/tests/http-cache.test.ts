import { afterEach, describe, expect, it, vi } from 'vitest';
import { cached, cacheKey } from '../src/cache';
import { fetchJson, HttpError, USER_AGENT } from '../src/http';
import { fakeKv, jsonResponse, stubFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('fetchJson', () => {
  it('sends the User-Agent and an abort signal, returns parsed JSON', async () => {
    const { fn } = stubFetch({ 'api.example.com': () => jsonResponse({ ok: 1 }) });
    await expect(fetchJson<{ ok: number }>('https://api.example.com/x')).resolves.toEqual({ ok: 1 });
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws HttpError with the status on non-2xx', async () => {
    stubFetch({ 'api.example.com': () => jsonResponse({ error: 'slow down' }, 429) });
    const err = await fetchJson('https://api.example.com/x').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as Error).message).toBe('HTTP 429 from api.example.com');
  });

  it('rejects on a non-JSON body', async () => {
    stubFetch({ 'api.example.com': () => new Response('<html>oops</html>', { status: 200 }) });
    await expect(fetchJson('https://api.example.com/x')).rejects.toThrow();
  });
});

describe('cached', () => {
  it('loads once, then serves from KV with the TTL', async () => {
    const kv = fakeKv();
    const put = vi.spyOn(kv, 'put');
    const load = vi.fn(async () => ({ n: 1 }));
    expect(await cached(kv, 'https://x/?q=a', 3600, load)).toEqual({ n: 1 });
    expect(await cached(kv, 'https://x/?q=a', 3600, load)).toEqual({ n: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(await cacheKey('https://x/?q=a'), JSON.stringify({ n: 1 }), { expirationTtl: 3600 });
  });

  it('keys are hashed so any source length fits KV limits and differs per source', async () => {
    const a = await cacheKey('https://x/?q=' + 'a'.repeat(5000));
    const b = await cacheKey('https://x/?q=' + 'a'.repeat(5000) + 'b');
    expect(a).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('cached: KV failures never fail the read', () => {
  it('returns the loaded value when put throws (e.g. daily write quota exhausted)', async () => {
    const kv = fakeKv();
    kv.put = async () => { throw new Error('KV PUT failed: 429'); };
    await expect(cached(kv, 'https://x/?q=quota', 60, async () => ({ n: 2 }))).resolves.toEqual({ n: 2 });
  });

  it('treats a throwing get as a cache miss', async () => {
    const kv = fakeKv();
    kv.get = (async () => { throw new Error('KV GET failed'); }) as typeof kv.get;
    await expect(cached(kv, 'https://x/?q=miss', 60, async () => ({ n: 3 }))).resolves.toEqual({ n: 3 });
  });
});
