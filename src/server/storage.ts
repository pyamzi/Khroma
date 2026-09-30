import { AwsClient } from 'aws4fetch';

export type StoredObject = { body: ReadableStream<Uint8Array>; size: number; contentType: string };
export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  getBytes(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export type PhotoVariant = 'original' | 'draft' | 'preview' | 'preview.draft' | 'thumb' | 'thumb.draft';
export const photoKey = (studioId: string, photoId: string, variant: PhotoVariant) => `s/${studioId}/p/${photoId}/${variant}`;

/** Tests and local dev. */
export function memoryStorage(): Storage & { keys(): string[] } {
  const m = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(key, body, contentType) { m.set(key, { bytes: new Uint8Array(body), contentType }); },
    async get(key) { const o = m.get(key); return o ? { body: new Blob([o.bytes]).stream(), size: o.bytes.byteLength, contentType: o.contentType } : null; },
    async getBytes(key) { return m.get(key)?.bytes ?? null; },
    async delete(key) { m.delete(key); },
    keys: () => [...m.keys()],
  };
}

/** Cloudflare R2 through its S3 API. */
export function r2Storage(o: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; fetch?: typeof fetch }): Storage {
  const aws = new AwsClient({ accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, service: 's3', region: 'auto' });
  const f = o.fetch ?? fetch;
  const url = (key: string) => `https://${o.accountId}.r2.cloudflarestorage.com/${o.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const call = async (method: string, key: string, init: RequestInit = {}) => {
    const res = await f(await aws.sign(url(key), { method, ...init }));
    if (!res.ok && res.status !== 404) throw new Error(`R2 ${method} ${key} failed: ${res.status}`);
    return res;
  };
  return {
    async put(key, body, contentType) { await call('PUT', key, { body, headers: { 'content-type': contentType } }); },
    async get(key) {
      const res = await call('GET', key); if (res.status === 404 || !res.body) return null;
      return { body: res.body, size: Number(res.headers.get('content-length') ?? 0), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    },
    async getBytes(key) { const res = await call('GET', key); return res.status === 404 ? null : new Uint8Array(await res.arrayBuffer()); },
    async delete(key) { await call('DELETE', key); },
  };
}
