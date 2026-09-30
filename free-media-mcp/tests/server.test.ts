import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { GET_ATTRIBUTION_DESCRIPTION, GET_MEDIA_DESCRIPTION, SEARCH_MEDIA_DESCRIPTION } from '../src/server';
import { OV_IMAGE, PX_PHOTO } from './fixtures';
import { fakeEnv, jsonResponse, stubFetch } from './helpers';
import type { Env } from '../src/env';

afterEach(() => vi.unstubAllGlobals());

/** In-process client: the transport's fetch is the Worker's fetch, no network. */
async function connect(env: Env) {
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => worker.fetch(new Request(url, init), env),
  });
  const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return client;
}

const textOf = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as Array<{ type: string; text: string }>)[0]!.text;

describe('worker gate', () => {
  it('404 off /mcp, 401 when MCP_TOKEN is set and missing, 429 when the limiter says no', async () => {
    expect((await worker.fetch(new Request('http://x/other'), fakeEnv())).status).toBe(404);
    expect((await worker.fetch(new Request('http://x/mcp', { method: 'POST' }), fakeEnv({ MCP_TOKEN: 's3cret' }))).status).toBe(401);
    const limited = fakeEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } });
    expect((await worker.fetch(new Request('http://x/mcp', { method: 'POST' }), limited)).status).toBe(429);
  });

  it('accepts the bearer token and keys the limiter by client IP', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const env = fakeEnv({ MCP_TOKEN: 's3cret', RATE_LIMITER: { limit } });
    const res = await worker.fetch(
      new Request('http://x/mcp', { method: 'POST', headers: { authorization: 'Bearer s3cret', 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }),
      env,
    );
    expect(res.status).not.toBe(401);
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.9' });
  });
});

describe('tools', () => {
  it('lists exactly the three tools with the required description content', async () => {
    const client = await connect(fakeEnv());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_attribution', 'get_media', 'search_media']);
    const search = tools.find((t) => t.name === 'search_media')!;
    expect(search.description).toBe(SEARCH_MEDIA_DESCRIPTION);
    expect(search.description).toMatch(/Openverse .*does not verify license/);
    expect(search.description).toContain('get_attribution');
    expect(search.description).toMatch(/NC.*ND/);
    expect(tools.find((t) => t.name === 'get_media')!.description).toBe(GET_MEDIA_DESCRIPTION);
    expect(tools.find((t) => t.name === 'get_attribution')!.description).toBe(GET_ATTRIBUTION_DESCRIPTION);
    expect(search.annotations?.readOnlyHint).toBe(true);
    expect(search.description).toContain('Wikimedia Commons');
    const props = (search.inputSchema as { properties: Record<string, { items?: { enum?: string[] } }> }).properties;
    expect(props.sources?.items?.enum).toEqual(['pexels', 'pixabay', 'wikimedia', 'flickr']);
  });

  it('search_media returns compact JSON with results and warnings, defaults applied', async () => {
    const { calls } = stubFetch({
      'api.openverse.org': () => jsonResponse({ results: [OV_IMAGE] }),
      'api.pexels.com': () => jsonResponse({ photos: [PX_PHOTO] }),
      'pixabay.com': () => jsonResponse({ hits: [] }),
    });
    const client = await connect(fakeEnv());
    const res = await client.callTool({ name: 'search_media', arguments: { query: 'golden hour wedding couple' } });
    const body = JSON.parse(textOf(res)) as { results: Array<{ id: string; license: { code: string } }>; warnings: string[] };
    expect(body.results.map((r) => r.id)).toEqual(['openverse:575fdc8f-9f62-431c-a24d-9717001ff2ba', 'pexels:2014422']);
    expect(body.warnings).toEqual([]);
    expect(textOf(res)).not.toContain('\n');
    expect(calls.find((u) => u.hostname === 'api.openverse.org')!.searchParams.get('page_size')).toBe('8');
  });

  it('rejects whitespace-only query, limit 0 and 21, empty ids', async () => {
    const client = await connect(fakeEnv());
    for (const args of [{ query: '   ' }, { query: 'x', limit: 0 }, { query: 'x', limit: 21 }]) {
      const res = await client.callTool({ name: 'search_media', arguments: args });
      expect(res.isError).toBe(true);
    }
    expect((await client.callTool({ name: 'get_attribution', arguments: { ids: [] } })).isError).toBe(true);
  });

  it('get_media returns renditions; bad ids are isError with the expected format', async () => {
    stubFetch({ 'api.pexels.com': () => jsonResponse(PX_PHOTO) });
    const client = await connect(fakeEnv());
    const ok = await client.callTool({ name: 'get_media', arguments: { id: 'pexels:2014422' } });
    expect(JSON.parse(textOf(ok)).renditions).toHaveLength(8);
    const bad = await client.callTool({ name: 'get_media', arguments: { id: 'nope' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('expected "provider:native_id"');
  });

  it('get_attribution credits valid ids per format and reports bad ids per item', async () => {
    stubFetch({ 'api.pexels.com': () => jsonResponse(PX_PHOTO), 'api.openverse.org': () => jsonResponse(OV_IMAGE) });
    const client = await connect(fakeEnv());
    const res = await client.callTool({ name: 'get_attribution', arguments: { ids: ['pexels:2014422', 'openverse:' + OV_IMAGE.id, 'bogus'], format: 'markdown' } });
    const body = JSON.parse(textOf(res)) as { format: string; credits: Array<{ id: string; credit?: string; error?: string }> };
    expect(body.format).toBe('markdown');
    expect(body.credits[0]).toEqual({ id: 'pexels:2014422', credit: 'Photo by [Joey Farina](https://www.pexels.com/@joey) on [Pexels](https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/)' });
    expect(body.credits[1]!.credit).toContain('is licensed under [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)');
    expect(body.credits[2]).toEqual({ id: 'bogus', error: 'invalid id "bogus", expected "provider:native_id"' });
    expect(res.isError).toBeFalsy();
  });
});
