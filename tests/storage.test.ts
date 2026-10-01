import { describe, it, expect } from 'vitest';
import { memoryStorage, r2Storage, photoKey, zipKey } from '../src/server/storage.js';

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

describe('zipKey', () => {
  it('lives outside s/ so a lifecycle rule can expire it', () => { expect(zipKey('s1', 'p1', 'abc')).toBe('z/s1/p1/abc.zip'); });
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
  const cfg = { accountId: 'acc', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'opengallery-media' };
  it('r2 presignPut signs a 15-minute PUT for the exact key, content-type included', async () => {
    const url = new URL(await r2Storage(cfg).presignPut('s/a/p/b/original', 'image/jpeg', 900));
    expect(url.pathname).toBe('/opengallery-media/s/a/p/b/original');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
  });
  it('r2 presignGet sets an attachment filename', async () => {
    const url = new URL(await r2Storage(cfg).presignGet('k', 600, 'a "b".jpg'));
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="a b.jpg"');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(new URL(await r2Storage(cfg).presignGet('k', 600)).searchParams.has('response-content-disposition')).toBe(false);
  });
  it('r2 copy sends x-amz-copy-source and exists maps 404 to false', async () => {
    calls.length = 0;
    await make(200).copy('s/a b/x', 's/c/y');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('https://acc.r2.cloudflarestorage.com/b/s/c/y');
    expect(calls[0]!.headers.get('x-amz-copy-source')).toBe('/b/s/a%20b/x');
    expect(await make(200).exists('k')).toBe(true);
    expect(calls.at(-1)!.method).toBe('HEAD');
    expect(await make(404).exists('k')).toBe(false);
    await expect(make(500).exists('k')).rejects.toThrow(/500/);
  });
  it('r2 copy fails loudly on a missing source or a 200 with an <Error> body', async () => {
    await expect(make(404).copy('s/gone', 's/c/y')).rejects.toThrow(/source missing/);
    await expect(make(200, '<Error><Code>InternalError</Code></Error>').copy('s/a', 's/b')).rejects.toThrow(/error in response body/);
    await expect(make(200, '<CopyObjectResult><ETag>x</ETag></CopyObjectResult>').copy('s/a', 's/b')).resolves.toBeUndefined();
  });
});
