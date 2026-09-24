/** KV, not the Cache API: the Cache API is a no-op on *.workers.dev and Pixabay requires 24 h caching everywhere. */
export async function cacheKey(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return 'v1:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A KV failure (quota, transient error) is never allowed to fail the read: a miss just costs one provider call. */
export async function cached<T>(kv: KVNamespace, keySource: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const key = await cacheKey(keySource);
  const hit = await kv.get<T>(key, 'json').catch(() => null);
  if (hit !== null) return hit;
  const value = await load();
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds }).catch(() => undefined);
  return value;
}
