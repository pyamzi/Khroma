import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { AwsClient } from 'aws4fetch';

export type StoredObject = { body: ReadableStream<Uint8Array>; size: number; contentType: string };
export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Uploads a file from disk without holding it in memory (ZIPs run to gigabytes). */
  putFile(key: string, path: string, contentType: string): Promise<void>;
  /** The object's size in bytes, or null when it is missing; reads no body. */
  size(key: string): Promise<number | null>;
  get(key: string): Promise<StoredObject | null>;
  getBytes(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** A URL a browser can PUT the object to, valid for `ttlSec`. The upload must send exactly this content type. */
  presignPut(key: string, contentType: string, ttlSec: number): Promise<string>;
  /** A URL a browser can GET the object from; with `downloadName` it downloads as that file name. */
  presignGet(key: string, ttlSec: number, downloadName?: string): Promise<string>;
  copy(fromKey: string, toKey: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Only memory storage: createApp serves its presigned URLs from /dev/storage/*. */
  readonly dev?: true;
}

export type PhotoVariant = 'original' | 'draft' | 'preview' | 'preview.draft' | 'medium' | 'medium.draft' | 'thumb' | 'thumb.draft';
export const photoKey = (studioId: string, photoId: string, variant: PhotoVariant) => `s/${studioId}/p/${photoId}/${variant}`;
/** Outside `s/` so an R2 lifecycle rule can expire ZIPs. */
export const zipKey = (studioId: string, projectId: string, hash: string) => `z/${studioId}/${projectId}/${hash}.zip`;
const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');
const attachment = (name: string) => `attachment; filename="${name.replace(/["\\]/g, '')}"`;

/** Tests and local dev. */
export function memoryStorage(): Storage & { keys(): string[] } {
  const m = new Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string }>();
  return {
    async put(key, body, contentType) { m.set(key, { bytes: new Uint8Array(body), contentType }); },
    async putFile(key, path, contentType) { m.set(key, { bytes: new Uint8Array(await readFile(path)), contentType }); },
    async size(key) { return m.get(key)?.bytes.byteLength ?? null; },
    async get(key) { const o = m.get(key); return o ? { body: new Blob([o.bytes]).stream(), size: o.bytes.byteLength, contentType: o.contentType } : null; },
    async getBytes(key) { return m.get(key)?.bytes ?? null; },
    async delete(key) { m.delete(key); },
    async presignPut(key) { return `/dev/storage/${encodeKey(key)}`; },
    async presignGet(key, _ttl, downloadName) { return `/dev/storage/${encodeKey(key)}${downloadName ? `?response-content-disposition=${encodeURIComponent(attachment(downloadName))}` : ''}`; },
    async copy(from, to) { const o = m.get(from); if (!o) throw new Error(`copy: no such key ${from}`); m.set(to, o); },
    async exists(key) { return m.has(key); },
    dev: true,
    keys: () => [...m.keys()],
  };
}

/** Cloudflare R2 through its S3 API. */
export function r2Storage(o: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; fetch?: typeof fetch }): Storage {
  const aws = new AwsClient({ accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, service: 's3', region: 'auto' });
  const f = o.fetch ?? fetch;
  const url = (key: string) => `https://${o.accountId}.r2.cloudflarestorage.com/${o.bucket}/${encodeKey(key)}`;
  const presign = async (method: string, key: string, ttlSec: number, query: Record<string, string> = {}, headers?: Record<string, string>) => {
    const u = new URL(url(key)); u.searchParams.set('X-Amz-Expires', String(ttlSec));
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    // allHeaders: aws4fetch leaves content-type unsigned by default; signing it makes R2 reject an upload of any other type
    return (await aws.sign(u, { method, headers, aws: { signQuery: true, allHeaders: true } })).url;
  };
  const call = async (method: string, key: string, init: RequestInit = {}) => {
    const res = await f(await aws.sign(url(key), { method, ...init }));
    if (!res.ok && res.status !== 404) throw new Error(`R2 ${method} ${key} failed: ${res.status}`);
    return res;
  };
  return {
    async put(key, body, contentType) { await call('PUT', key, { body: body as unknown as BodyInit, headers: { 'content-type': contentType } }); },
    // A file stream with an explicit content-length (R2 rejects chunked PUTs); a whole-file Blob body makes undici read it all into memory.
    // With x-amz-content-sha256: UNSIGNED-PAYLOAD (aws4fetch's own default for s3 header signing, set here explicitly) aws4fetch never hashes or reads the body.
    async putFile(key, path, contentType) {
      const body = Readable.toWeb(createReadStream(path)) as unknown as BodyInit;
      await call('PUT', key, { body, duplex: 'half', headers: { 'content-type': contentType, 'content-length': String((await stat(path)).size), 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } } as RequestInit);
    },
    async size(key) { const res = await call('HEAD', key); return res.status === 404 ? null : Number(res.headers.get('content-length') ?? 0); },
    async get(key) {
      const res = await call('GET', key); if (res.status === 404 || !res.body) return null;
      return { body: res.body, size: Number(res.headers.get('content-length') ?? 0), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    },
    async getBytes(key) { const res = await call('GET', key); return res.status === 404 ? null : new Uint8Array(await res.arrayBuffer()); },
    async delete(key) { await call('DELETE', key); },
    presignPut: (key, contentType, ttlSec) => presign('PUT', key, ttlSec, {}, { 'content-type': contentType }),
    presignGet: (key, ttlSec, downloadName) => presign('GET', key, ttlSec, downloadName ? { 'response-content-disposition': attachment(downloadName) } : {}),
    async copy(from, to) {
      const res = await call('PUT', to, { headers: { 'x-amz-copy-source': `/${o.bucket}/${encodeKey(from)}` } });
      // a missing source is a 404 (which `call` lets through); S3 can also fail a CopyObject with a 200 carrying an <Error> body
      if (res.status === 404 || (await res.text()).includes('<Error>')) throw new Error(`R2 COPY ${from} → ${to} failed: ${res.status === 404 ? 'source missing' : 'error in response body'}`);
    },
    async exists(key) { return (await call('HEAD', key)).status === 200; },
  };
}
