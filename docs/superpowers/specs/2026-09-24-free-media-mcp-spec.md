# Task: Build "OpenGallery Free Media MCP" (v1)

> Spec as supplied by the product owner on 2026-09-24. Kept verbatim so the implementation plan (`docs/superpowers/plans/2026-09-24-free-media-mcp.md`) can argue from it.

You are building a remote MCP server that lets Claude search free, legally reusable images and videos from multiple providers through ONE unified interface, with license info and attribution normalized so Claude can safely place results into Canva designs and web pages.

This is v1 of a feature for OpenGallery, a photography/videography asset management and delivery app. Keep it small, correct, and deployable. Do not add features beyond this spec.

## Before writing code
1. Read the CURRENT docs for: the MCP TypeScript SDK, Cloudflare's guide to building remote MCP servers on Workers, the Openverse API (api.openverse.org/v1), and the Pexels API (images AND videos). Do not rely on memory for SDK class names, transport types, or endpoint shapes; they change.
2. Read Anthropic's docs on adding remote MCP servers as custom connectors in claude.ai, specifically what authentication methods are supported. Choose auth based on what you find (see Auth section).
3. If Pixabay's API supports photos and videos with a free key, include it as an optional third provider. If you cannot confirm its terms or endpoints, skip it and say so.
4. State any assumptions or ambiguities you found in a short list before implementing.

## Stack
- TypeScript, Cloudflare Workers, deployed with Wrangler.
- Official MCP TypeScript SDK (or Cloudflare's recommended MCP wrapper, if the docs say that is the current best practice).
- Streamable HTTP transport (verify this is current).
- Secrets via Wrangler secrets: PEXELS_API_KEY, PIXABAY_API_KEY (optional).
- Vitest for tests, with mocked fetch. No real network calls in tests.

## Tools (exactly these three)

### 1. search_media
Inputs:
- query (string, required, English)
- media_type: "image" | "video" (default "image")
- commercial_use_only (boolean, default true)
- modification_allowed (boolean, default true) — excludes licenses that forbid derivatives, since designs crop and edit images
- orientation: "landscape" | "portrait" | "square" | "any" (default "any")
- providers: array of provider ids (default: all configured providers that support the media_type)
- limit (int, default 8, max 20) — total across providers

Behavior:
- Query providers in parallel. One provider failing must not fail the whole call; report it in a `warnings` array.
- Openverse is image-only here. Do not send video queries to it.
- Interleave results across providers instead of listing one provider first.
- Apply license filters AFTER normalization (see License rules).

Output: a compact array of MediaResult objects (schema below) plus `warnings`. Keep responses small, because every token returned costs the user context. No raw provider JSON.

### 2. get_media
Input: id (the unified id from search_media, format "provider:native_id").
Output: one full MediaResult including all available sizes/renditions (for video: available resolutions and direct file URLs if the provider gives them).

### 3. get_attribution
Inputs: ids (array), format: "text" | "html" | "markdown".
Output: ready-to-paste credit lines, one per item, following each provider's attribution guidance. For CC licenses, include title, creator, source link, license name, and license link (the standard TASL pattern).

## MediaResult schema
```ts
{
  id: string;              // "openverse:abc123", "pexels:456"
  provider: "openverse" | "pexels" | "pixabay";
  media_type: "image" | "video";
  title: string | null;
  creator: string | null;
  creator_url: string | null;
  source_page_url: string;  // human page on the provider site
  preview_url: string;      // small thumbnail
  full_url: string;         // best large rendition
  width: number | null;
  height: number | null;
  duration_seconds: number | null; // video only
  license: {
    code: string;           // normalized: "cc0","pdm","cc-by","cc-by-sa","cc-by-nd","cc-by-nc","cc-by-nc-sa","cc-by-nc-nd","pexels","pixabay"
    name: string;
    url: string | null;
    commercial_use: boolean;
    modification_allowed: boolean;
    attribution_required: boolean;
    share_alike: boolean;
  };
  attribution_text: string; // plain text credit line
}
```

## License rules (be exact, and put this logic in one small, well-tested module)
- cc0, pdm: commercial yes, modification yes, attribution not required.
- cc-by: commercial yes, modification yes, attribution required.
- cc-by-sa: commercial yes, modification yes, attribution required, share_alike true.
- cc-by-nd: commercial yes, modification NO.
- any "nc" license: commercial NO.
- Pexels and Pixabay content: set from each provider's CURRENT license page, which you must read. Do not guess. Mark attribution_required according to their API guidelines (Pexels asks for credit when possible).
- Unknown or unmapped license: exclude the result when commercial_use_only is true, and never mark it as safe.
- Openverse states it cannot guarantee license accuracy. Include a one-line note to that effect in the tool description of search_media so Claude surfaces it to users.

## Provider compliance
- Respect each provider's rate limits. Cache identical searches for 1 hour using the Workers Cache API (or KV if the Cache API does not fit; justify the choice). Caching must not violate any provider's terms; check.
- Set a descriptive User-Agent.
- Read Pexels' and Pixabay's API terms for rules about caching, hotlinking, and not replicating their core service, and follow them. Summarize any constraints you found in the README.

## Auth
The server holds the API keys, so the endpoint must not be open to unlimited public abuse. Based on what the claude.ai custom connector docs support, pick the simplest option that works in claude.ai web: OAuth if required, otherwise a secret path token or authless with basic per-IP rate limiting. Explain the tradeoff in two or three sentences in the README.

## Tool descriptions matter
Write tool descriptions for Claude as the reader: when to use each tool, that results are free-license media, that Claude should call get_attribution before placing media in a public design, and that NC or ND results are filtered by default for a reason.

## Tests (must pass)
- License normalization: every code in the rules table maps correctly, and filters exclude the right items.
- search_media: parallel provider calls, one provider erroring still returns the others plus a warning, limit respected, video queries skip Openverse.
- get_attribution: correct output in all three formats.
- All tests use mocked fetch.

## Deliverables
1. Complete repo: src/, tests/, wrangler config, package.json, tsconfig, .dev.vars.example.
2. README with: what it does, setup (get keys), local dev, testing with MCP Inspector, deploy with Wrangler, how to add it as a custom connector in claude.ai, compliance notes per provider, and known limitations.
3. A short example session in the README: searching "golden hour wedding couple" images, then getting attribution, then a note on how Claude would pass full_url to Canva's upload-from-URL tool.

## Constraints
- Minimum code that meets this spec. No UI, no database, no user accounts, no downloading or storing media, no Unsplash in v1.
- No abstractions for a single use. A small provider interface is fine because there are 2 to 3 providers.
- If something in this spec conflicts with what the current docs or provider terms say, follow the docs and terms, and tell me what you changed and why.

## Definition of done
`npm test` passes, `wrangler dev` runs, MCP Inspector lists the three tools, and a real search against Openverse and Pexels returns correctly licensed, filtered results.
