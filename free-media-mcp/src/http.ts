export const USER_AGENT = 'OpenGallery-FreeMediaMCP/0.1 (+https://github.com/pyamzi/OpenGallery)';

export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} from ${new URL(url).hostname}`);
    this.name = 'HttpError';
  }
}

export interface JsonInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** GET/POST JSON with a descriptive User-Agent and a hard timeout so one slow provider cannot stall a tool call. */
export async function fetchJson<T>(url: string, init: JsonInit = {}, timeoutMs = 8000): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init.headers },
    body: init.body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}
