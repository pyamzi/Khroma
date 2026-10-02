import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { attribution } from './attribution';
import type { Env } from './env';
import { errorMessage, getMedia, searchMedia } from './search';
import { PROVIDER_IDS, SOURCE_IDS } from './types';

export const SEARCH_MEDIA_DESCRIPTION =
  'Search free, legally reusable stock images or videos from Openverse (Creative Commons and public-domain images), Pexels, and Pixabay in one call, ' +
  'and get back a compact list with a normalized license block per item. Use it when a design, web page, or post needs a photo or video and the user has no asset of their own. ' +
  'By default results under non-commercial (NC) or no-derivatives (ND) licenses are filtered out, because designs are usually commercial and crop or edit the media; ' +
  'set commercial_use_only or modification_allowed to false only when the user explicitly accepts that restriction. ' +
  'Before placing any result in a public design, page, or post, call get_attribution with the ids and include the credit line. ' +
  'Openverse aggregates third-party metadata and does not verify license accuracy: tell the user to confirm the license on the source page before commercial use. ' +
  'Each result names its Source, the site that hosts the work. To search only Wikimedia Commons or Flickr, pass sources: ["wikimedia"] or ["flickr"]; those come through Openverse and are images only. ' +
  'When you show Pexels results, mention that photos are provided by Pexels. ' +
  'Providers are queried in parallel; a provider that fails is reported in "warnings" instead of failing the call.';

export const GET_MEDIA_DESCRIPTION =
  'Fetch one item from search_media by its id ("provider:native_id"; videos look like "pexels:video:123") with every available rendition: ' +
  'for images each size with its URL and dimensions, for videos each resolution with a direct file URL. ' +
  'Use it when you need a specific size or the direct video file, not for discovery.';

export const GET_ATTRIBUTION_DESCRIPTION =
  'Build ready-to-paste credit lines for items returned by search_media, as plain text, HTML, or Markdown. ' +
  'Creative Commons and public-domain items get title, creator, source link, license name, and license link (TASL); Pexels and Pixabay items get the credit their API guidelines ask for. ' +
  'Call this before placing media in a public design, page, or post, and put the line next to the media or in a credits section. ' +
  'Items whose license has attribution_required=false still get a line; crediting is always appreciated by the providers.';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: errorMessage(e) }], isError: true });

export function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: 'kreate-free-media', version: '0.1.0' });

  server.registerTool(
    'search_media',
    {
      title: 'Search free media',
      description: SEARCH_MEDIA_DESCRIPTION,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        // refine (not .trim()) so the schema stays representable as JSON Schema; searchMedia trims the value itself.
        query: z.string().min(1).max(200).refine((s) => s.trim().length > 0, { message: 'query must not be blank' }).describe('Search terms in English, e.g. "golden hour wedding couple"'),
        media_type: z.enum(['image', 'video']).default('image'),
        commercial_use_only: z.boolean().default(true).describe('Exclude licenses that forbid commercial use (every CC NC variant, unknown licenses)'),
        modification_allowed: z.boolean().default(true).describe('Exclude licenses that forbid derivatives (CC ND variants); designs crop and edit media'),
        orientation: z.enum(['landscape', 'portrait', 'square', 'any']).default('any'),
        providers: z.array(z.enum(PROVIDER_IDS)).optional().describe('Restrict to these providers; default is every configured provider that supports media_type'),
        sources: z.array(z.enum(SOURCE_IDS)).optional().describe('Restrict to works hosted by these Sources, e.g. ["wikimedia"] for Wikimedia Commons'),
        limit: z.number().int().min(1).max(20).default(8).describe('Total results across providers'),
      }),
    },
    async (input) => {
      try {
        return text(await searchMedia(input, env));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_media',
    {
      title: 'Get media details',
      description: GET_MEDIA_DESCRIPTION,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ id: z.string().describe('Unified id from search_media, "provider:native_id"') }),
    },
    async ({ id }) => {
      try {
        return text(await getMedia(id, env));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_attribution',
    {
      title: 'Get attribution lines',
      description: GET_ATTRIBUTION_DESCRIPTION,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).max(20).describe('Unified ids from search_media'),
        format: z.enum(['text', 'html', 'markdown']).default('text'),
      }),
    },
    async ({ ids, format }) => {
      const settled = await Promise.allSettled(ids.map((id) => getMedia(id, env)));
      const credits = settled.map((s, i) =>
        s.status === 'fulfilled' ? { id: ids[i]!, credit: attribution(s.value, format) } : { id: ids[i]!, error: errorMessage(s.reason) },
      );
      return text({ format, credits });
    },
  );

  return server;
}
