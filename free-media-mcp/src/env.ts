export interface Env {
  PEXELS_API_KEY?: string;
  PIXABAY_API_KEY?: string;
  OPENVERSE_CLIENT_ID?: string;
  OPENVERSE_CLIENT_SECRET?: string;
  MCP_TOKEN?: string;
  MEDIA_CACHE: KVNamespace;
  RATE_LIMITER: RateLimit;
}
