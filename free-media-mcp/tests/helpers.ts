import { vi } from 'vitest';
import type { Env } from '../src/env';

export function fakeKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    store,
    get: async (key: string) => {
      const v = store.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
  return kv as unknown as KVNamespace & { store: Map<string, string> };
}

export function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PEXELS_API_KEY: 'pexels-test-key',
    PIXABAY_API_KEY: 'pixabay-test-key',
    MEDIA_CACHE: fakeKv(),
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  };
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Stubs global fetch; routes by hostname. Unrouted hosts throw so no test can leak to the network. */
export function stubFetch(routes: Record<string, Route>) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const route = routes[url.hostname];
    if (!route) throw new Error(`unexpected fetch to ${url.hostname}`);
    return route(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}
