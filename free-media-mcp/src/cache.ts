/** KV, not the Cache API: the Cache API is a no-op on *.workers.dev and Pixabay requires 24 h caching everywhere. */
export async function cacheKey(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return 'v1:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function cached<T>(kv: KVNamespace, keySource: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const key = await cacheKey(keySource);
  const hit = await kv.get<T>(key, 'json');
  if (hit !== null) return hit;
  const value = await load();
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  return value;
}
