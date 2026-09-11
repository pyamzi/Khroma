export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(init.headers ?? {}) } });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({ error: res.statusText }))).error);
  return res.json() as Promise<T>;
}
