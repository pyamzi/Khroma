# Kreate Free Media MCP

A remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that lets Claude search free, legally reusable images and videos from **Openverse**, **Pexels**, and **Pixabay** through one interface. Every result carries a normalized license block and a ready-made credit line, so Claude can drop media into Canva designs or web pages without guessing at rights.

Tools:

| Tool | Purpose |
| --- | --- |
| `search_media` | Query all configured providers in parallel; interleaved, license-filtered, compact results plus `warnings`. |
| `get_media` | One item by id with every rendition (image sizes, video resolutions with direct file URLs). |
| `get_attribution` | Paste-ready credit lines in `text`, `html`, or `markdown` (TASL for Creative Commons). |

Every result names its **Source**, the site that hosts the work: Pexels, Pixabay, Wikimedia Commons, Flickr, or another collection Openverse indexes. To search only one Source, pass `sources`, for example `{"query": "eiffel tower at night", "sources": ["wikimedia"]}`. Wikimedia Commons and Flickr come through Openverse and are images only. Credits for Creative Commons works name the Source ("by dalecruse via Flickr is licensed under CC BY 2.0").

By default `search_media` hides non-commercial (NC) and no-derivatives (ND) licenses: designs are commercial and crop or edit the media. Unknown or unmapped licenses are never marked safe and only appear when both filters are off.

## Setup: get keys

| Secret | Required | Where |
| --- | --- | --- |
| `PEXELS_API_KEY` | Yes, for Pexels | <https://www.pexels.com/api/> (free, instant) |
| `PIXABAY_API_KEY` | Optional third provider | <https://pixabay.com/api/docs/> (free; the key is shown on the docs page when signed in) |
| `OPENVERSE_CLIENT_ID` / `OPENVERSE_CLIENT_SECRET` | Optional but recommended for production | `POST https://api.openverse.org/v1/auth_tokens/register/` with `name`, `description`, `email`; verify the email. Anonymous Openverse is 20 requests/min and 200/day **per IP**, and Workers share egress IPs. |
| `MCP_TOKEN` | Optional | Any long random string; when set, clients must send `Authorization: Bearer <token>`. |

Openverse works without credentials. With no Pexels key only Openverse answers, and video searches return nothing.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in keys
npm run dev                      # http://127.0.0.1:8787/mcp
```

Smoke test:

```bash
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`npm test` runs the Vitest suite (all provider calls use a mocked `fetch`; no network). `npm run typecheck` runs `tsc`.

## Testing with MCP Inspector

```bash
npm run inspector
```

In the Inspector UI choose transport **Streamable HTTP**, URL `http://127.0.0.1:8787/mcp` (add header `Authorization: Bearer …` if `MCP_TOKEN` is set), click **Connect**, then **List Tools**. Run `search_media` with `{"query": "golden hour wedding couple"}`.

Headless equivalent:

```bash
npx @modelcontextprotocol/inspector@latest --cli http://127.0.0.1:8787/mcp --transport http --method tools/list
```

## Deploy

```bash
npx wrangler login
npx wrangler kv namespace create MEDIA_CACHE     # paste the id into wrangler.jsonc
npx wrangler secret put PEXELS_API_KEY
npx wrangler secret put PIXABAY_API_KEY          # optional
npx wrangler secret put OPENVERSE_CLIENT_ID      # optional
npx wrangler secret put OPENVERSE_CLIENT_SECRET  # optional
npx wrangler secret put MCP_TOKEN                # optional
npm run deploy
```

The endpoint is `https://opengallery-free-media-mcp.<your-account>.workers.dev/mcp`. Anything else on the host returns 404.

## Add it to claude.ai as a custom connector

1. **Customize > Connectors > Add custom connector** (Team/Enterprise owners: **Organization settings > Connectors > Add > Custom**).
2. Name it, paste the `/mcp` URL, continue. Claude probes the URL and should detect **No sign-in**.
3. If you set `MCP_TOKEN` and your organization has the **Request headers** section (beta), add header `Authorization` with value `Bearer <token>` (include the word `Bearer` and the space). Without that section, leave `MCP_TOKEN` unset.
4. Add, then enable the connector in a chat via the **+** menu.

Claude Code: `claude mcp add --transport http free-media https://<host>/mcp`; when using a token, pass the header with the flag shown by `claude mcp add --help` (currently `--header "Authorization: Bearer <token>"`).

**Auth tradeoff.** claude.ai custom connectors support authless servers, OAuth, and (in beta, for some organizations) fixed request headers; Anthropic advises against tokens in the URL. Running authless with a per-IP rate limit (60 requests/min per IP at the edge) is the only option that works for every claude.ai plan today, and the keys it protects are free-tier keys with their own provider-side limits. If your organization has request-header auth, set `MCP_TOKEN` to close the endpoint entirely. Note that some org-managed tenants have reported authless custom connectors failing to connect (anthropics/claude-ai-mcp#402); the fallback is a local `mcp-remote` bridge in Claude Desktop.

## Example session

User: *"Find a golden hour wedding couple photo for the homepage hero and credit it."*

1. Claude calls `search_media` with `{"query":"golden hour wedding couple","orientation":"landscape","limit":6}` and gets, for example:

   ```json
   {"results":[{"id":"openverse:575fdc8f-9f62-431c-a24d-9717001ff2ba","provider":"openverse","media_type":"image","title":"Bride and groom in Hanoi","creator":"PiktourUK","creator_url":"https://www.flickr.com/photos/69706441@N03","source_page_url":"https://www.flickr.com/photos/69706441@N03/33351721606","preview_url":"https://api.openverse.org/v1/images/575fdc8f-9f62-431c-a24d-9717001ff2ba/thumb/","full_url":"https://live.staticflickr.com/752/33351721606_c98d0875a6_b.jpg","width":1024,"height":837,"duration_seconds":null,"license":{"code":"cc-by","name":"CC BY 2.0","url":"https://creativecommons.org/licenses/by/2.0/","commercial_use":true,"modification_allowed":true,"attribution_required":true,"share_alike":false},"attribution_text":"\"Bride and groom in Hanoi\" by PiktourUK is licensed under CC BY 2.0. Source: https://www.flickr.com/photos/69706441@N03/33351721606 License: https://creativecommons.org/licenses/by/2.0/"},{"id":"pexels:2014422","provider":"pexels", "...":"..."}],"warnings":[]}
   ```

   Claude shows the user the previews, notes that the Openverse item's license should be confirmed on the Flickr page, and that Pexels photos are provided by Pexels.

2. User picks the Pexels photo. Claude calls `get_attribution` with `{"ids":["pexels:2014422"],"format":"html"}` and receives `Photo by <a href="https://www.pexels.com/@joey">Joey Farina</a> on <a href="https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/">Pexels</a>`.

3. To place it in Canva, Claude passes `full_url` (or a specific rendition from `get_media`) to Canva's **upload asset from URL** tool, then adds the credit line as a text element or in the page footer. Canva fetches the file once; nothing is downloaded or stored by this server.

## Provider compliance notes

**Openverse** (<https://docs.openverse.org/terms_of_service.html>)
- Openverse does not verify license metadata; the `search_media` description tells Claude to say so. Confirm on `source_page_url` before commercial use.
- Anonymous: 20 req/min, 200/day per IP. Register an app for higher limits. Scraping is disallowed; we request at most 20 results per query and cache for 1 hour.
- Image-only here (Openverse has no video catalog).

**Wikimedia Commons** (<https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia>)
- Reached through Openverse's `source=wikimedia` filter, so Openverse's rate limits and "does not verify licenses" caveat apply.
- Commons asks reusers to credit the author, name and link the license, and link the file page; the generated credit does all four and adds "via Wikimedia Commons".
- Commons says hotlinking is possible but not recommended. Treat `full_url` as a one-time import, not an embed.

**Pexels** (<https://www.pexels.com/api/documentation/#guidelines>, <https://www.pexels.com/license/>)
- Free for commercial use and modification; attribution not required by the license, but the API guidelines ask to credit photographers when possible and to show a prominent "Photos provided by Pexels" link. We set `attribution_required: true` and generate "Photo by X on Pexels" credits.
- Not allowed: selling unaltered copies, redistributing on stock or wallpaper platforms, implying endorsement by people or brands, use in trademarks, replicating Pexels' core functionality, working around rate limits.
- Rate limit 200 req/hour, 20,000/month per key. Identical searches are cached 1 hour.

**Pixabay** (<https://pixabay.com/api/docs/>, <https://pixabay.com/service/license-summary/>)
- Free for commercial use and modification; attribution not required, so `attribution_required: false`, but a credit line is still generated and the API terms require showing users where media comes from (`source_page_url` and the credit do that).
- API terms require caching responses for 24 hours (we cache Pixabay for 86,400 s), forbid permanent hotlinking of Pixabay URLs, and forbid systematic mass downloads. `full_url` is meant for a one-time import (for example Canva upload-from-URL), not for embedding directly in a page.
- `imageURL`/`fullHDURL` need "full API access"; standard keys get `largeImageURL` (1280 px).
- Rate limit 100 req/min per key. Search terms are capped at 100 characters.

**All providers**: every request sends `User-Agent: Kreate-FreeMediaMCP/0.1 (+https://kreate.so)` and times out after 8 s. Nothing is downloaded or stored; the server only forwards metadata and URLs.

## Caching

Workers KV, not the Cache API: the Cache API is a no-op on `*.workers.dev` and is per-datacenter, while Pixabay requires 24 h caching regardless of where the Worker runs. Keys are SHA-256 hashes of the provider request URL (without API keys). TTLs: Openverse and Pexels 1 h, Pixabay 24 h, Openverse auth token until 5 minutes before expiry. On the KV free plan (1,000 writes/day) each uncached search writes one key per provider.

## Known limitations

- Rate limiting is per Cloudflare location and approximate, keyed by `cf-connecting-ip`; it is abuse mitigation, not accounting.
- Anonymous Openverse limits are per egress IP shared with other Workers; set the Openverse client credentials for anything beyond light use.
- Pixabay `square` and all Pixabay video orientation filtering happen after the fact by dimensions, so those provider slots may return fewer than requested.
- Pexels videos and Pixabay items have no title; Pexels photo titles are the `alt` text.
- `get_attribution` re-fetches each item through the provider detail endpoint (cached 1 h / 24 h per id), so a call with many Openverse ids spends that many requests against the anonymous 20/min burst limit. Every `search_media` result already carries a plain-text `attribution_text`; use `get_attribution` for the items actually placed, or set the Openverse client credentials.
- Wikimedia Commons comes through Openverse, which ingests only Commons images under Creative Commons licenses and about a day behind Commons. Most Commons public-domain files, and all Commons video, are not searchable here.
- No pagination, no color or size filters, no Unsplash (v1 scope).
