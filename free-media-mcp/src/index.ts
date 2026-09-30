import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Env } from './env';
import { buildServer } from './server';

// Stateless: a fresh McpServer per request, no session, no Durable Object.
// Gate order: path -> optional bearer token -> per-IP rate limit -> MCP.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });

    // ponytail: plain string compare; a 32-byte random token makes the timing side channel moot.
    if (env.MCP_TOKEN && request.headers.get('authorization') !== `Bearer ${env.MCP_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60' } });

    return createMcpHandler(() => buildServer(env)).fetch(request);
  },
};
