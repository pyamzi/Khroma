import { describe, it, expect } from 'vitest';
import { memoryStorage, r2Storage, photoKey } from '../src/server/storage.js';

const text = async (s: ReadableStream<Uint8Array>) => new Response(s).text();

describe('memoryStorage', () => {
  it('round-trips bytes and content type; missing is null; delete is idempotent', async () => {
    const s = memoryStorage();
    await s.put('k/a', new TextEncoder().encode('hello'), 'text/plain');
    const got = await s.get('k/a');
    expect([got!.size, got!.contentType, await text(got!.body)]).toEqual([5, 'text/plain', 'hello']);
    expect(new TextDecoder().decode((await s.getBytes('k/a'))!)).toBe('hello');
    expect(await s.get('nope')).toBeNull(); expect(await s.getBytes('nope')).toBeNull();
    await s.delete('k/a'); await s.delete('k/a');
    expect(s.keys()).toEqual([]);
  });
});

describe('photoKey', () => {
  it('namespaces by Studio and photo', () => { expect(photoKey('s1', 'p1', 'thumb.draft')).toBe('s/s1/p/p1/thumb.draft'); });
});

describe('r2Storage', () => {
  const calls: { method: string; url: string; headers: Headers }[] = [];
  const stub = (status: number, body = '') => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init); calls.push({ method: req.method, url: req.url, headers: req.headers });
    return new Response(status === 404 || status === 204 ? null : body, { status, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } });
  }) as typeof fetch;
  const make = (status: number, body?: string) => r2Storage({ accountId: 'acc', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'b', fetch: stub(status, body) });

  it('puts a signed object at the account endpoint', async () => {
    calls.length = 0;
    await make(200).put('s/s1/p/p1/original', new Uint8Array([1, 2]), 'image/jpeg');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('https://acc.r2.cloudflarestorage.com/b/s/s1/p/p1/original');
    expect(calls[0]!.headers.get('content-type')).toBe('image/jpeg');
    expect(calls[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
  });
  it('gets an object and maps 404 to null', async () => {
    const got = await make(200, 'abc').get('s/x');
    expect([got!.size, got!.contentType, await text(got!.body)]).toEqual([3, 'image/jpeg', 'abc']);
    expect(await make(404).get('s/x')).toBeNull();
    expect(await make(404).getBytes('s/x')).toBeNull();
  });
  it('deletes with DELETE and throws on server errors', async () => {
    calls.length = 0; await make(204).delete('s/x'); expect(calls[0]!.method).toBe('DELETE');
    await expect(make(500).put('s/x', new Uint8Array(1), 'image/jpeg')).rejects.toThrow(/500/);
  });
  it('encodes each key segment', async () => {
    calls.length = 0; await make(200).put('s/a b/p/c#d', new Uint8Array(1), 'image/jpeg');
    expect(calls[0]!.url).toBe('https://acc.r2.cloudflarestorage.com/b/s/a%20b/p/c%23d');
  });
});
