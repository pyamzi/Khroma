# OpenGallery Free Media MCP (v1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable Cloudflare Worker exposing one Streamable HTTP MCP endpoint with three tools (`search_media`, `get_media`, `get_attribution`) that search Openverse, Pexels, and Pixabay for free-license images and videos, normalize licenses, and produce paste-ready credit lines.

**Architecture:** One stateless Worker. `createMcpHandler` from the official SDK builds a fresh `McpServer` per request; tool handlers call a tiny orchestrator (`search.ts`) that fans out to three provider modules behind one small `Provider` interface, filters on a normalized `License`, and interleaves results. Provider responses are cached in Workers KV (1 h, 24 h for Pixabay per its terms). Access is gated by a per-IP Rate Limiting binding and an optional bearer token.

**Tech Stack:** TypeScript 5.x, Cloudflare Workers + Wrangler 4, `@modelcontextprotocol/server` 2.1 (stateless `createMcpHandler`), zod 4, Workers KV, Workers Rate Limiting binding, Vitest 5 with mocked `fetch`, `@modelcontextprotocol/client` 2.1 for one in-process integration test.

**Spec:** `docs/superpowers/specs/2026-09-24-free-media-mcp-spec.md`

## Research findings the plan is built on (verified 2026-09-24)

These were read from current sources, not memory. Executors do not re-derive them.

- **MCP TypeScript SDK is now v2 and split into packages.** Use `@modelcontextprotocol/server@2.1.0` (`McpServer`, `registerTool`, `createMcpHandler`) and `@modelcontextprotocol/client@2.1.0` (tests only). `registerTool(name, { description, inputSchema: z.object(...), annotations }, handler)`; the raw-shape `inputSchema` form is deprecated. Handlers return `{ content: [{ type: 'text', text }], isError? }`. `createMcpHandler(factory)` returns `{ fetch(request, options?) }`, is stateless by default (`sessionIdGenerator` undefined), needs no Durable Object, and on workerd the package's own shim selects the `@cfworker/json-schema` validator automatically (no validator config needed). Zod must be v4 (`zod ^4.2`).
- **Cloudflare's remote MCP guide** now recommends `createMcpHandler` for new stateless servers and marks `McpAgent` as legacy. Their example wraps the same SDK function via the `agents` package; we import it from the SDK directly to avoid the `agents` dependency and its peer set.
- **Cache API is a no-op on `*.workers.dev`** and in the dashboard preview, and is per-datacenter. Pixabay's terms require 24 h caching regardless. So cache lives in **KV** (`expirationTtl`, minimum 60 s; free plan: 100k reads/day, 1k writes/day, key ≤ 512 bytes).
- **Rate Limiting binding**: `ratelimits: [{ name, namespace_id, simple: { limit, period } }]`, `period` must be 10 or 60, `await env.X.limit({ key })` → `{ success }`, per-colo and approximate, works in `wrangler dev`.
- **claude.ai custom connectors** support `none` (authless), OAuth (DCR / CIMD / own client), and `static_headers` (beta, limited orgs). Anthropic explicitly discourages tokens in the URL. An authless server must answer the MCP POST with 200, never 401. A June 2026 issue (anthropics/claude-ai-mcp#402) reports org-managed authless connectors failing in some tenants; `mcp-remote` is the documented fallback.
- **Openverse**: `GET /v1/images/?q&page_size&license_type=commercial,modification&aspect_ratio=wide|tall|square&mature=false`; result fields `id,title,creator,creator_url,url,thumbnail,foreign_landing_url,license,license_version,license_url,width,height`; detail at `/v1/images/{id}/`; `q` ≤ 200 chars; image and audio only (no video). Anonymous limits observed in response headers: **20/min burst, 200/day sustained, per IP**. Workers egress IPs are shared, so anonymous is unreliable in production; registered apps (`POST /v1/auth_tokens/token/`, form-urlencoded `client_id, client_secret, grant_type=client_credentials` → `{ access_token, expires_in }`) get higher limits. Openverse ToS: "does not verify licensing information for individual works". Raw license codes: `by, by-sa, by-nd, by-nc, by-nc-sa, by-nc-nd, cc0, pdm, sampling+, nc-sampling+`.
- **Pexels**: header `Authorization: <key>`; 200 req/h, 20k/month. `GET /v1/search?query&orientation=landscape|portrait|square&per_page≤80`, photo `{ id,width,height,url,photographer,photographer_url,alt,src{original,large2x,large,medium,small,portrait,landscape,tiny} }`, `GET /v1/photos/:id`; `GET /v1/videos/search`, video `{ id,width,height,url,image,duration,user{name,url},video_files[{quality,file_type,width,height,link}] }`, `GET /v1/videos/videos/:id`. License: free for commercial use and modification, attribution not required; no selling unaltered copies, no redistribution on stock platforms, no implied endorsement, no use in trademarks. API guidelines: credit photographers when possible ("Photo by X on Pexels" linking to the photo page), show a prominent "Photos provided by Pexels" link, do not replicate core Pexels functionality, do not work around rate limits.
- **Pixabay**: free key; `GET https://pixabay.com/api/?key&q(≤100 chars)&orientation=horizontal|vertical&per_page(3..200)&safesearch=true`, hits `{ id,pageURL,previewURL,webformatURL,largeImageURL,fullHDURL?,imageURL?,imageWidth,imageHeight,user,user_id }` (`fullHDURL`/`imageURL` only with full API access); `&id=` fetches one item; `GET https://pixabay.com/api/videos/` hits `{ id,pageURL,duration,videos{large,medium,small,tiny}{url,width,height,thumbnail},user,user_id }` (no orientation param). 100 req/min. Terms: **responses must be cached for 24 hours**, **permanent hotlinking not allowed**, no systematic mass downloads, show users where media comes from. License: free for commercial use and modification, attribution not required; no standalone resale, no use with recognisable trademarks, no immoral use of identifiable people.

## Assumptions and deviations from the spec (state these to the owner)

1. **Repo location:** the Worker lives at `free-media-mcp/` inside the OpenGallery repo with its own `package.json`, on branch `feat/free-media-mcp` cut from `main`. It is a separate deployable from the main app (spec §13 puts the app's own MCP at `/mcp` in-process; this one is a remote Worker).
2. **Cache = KV, not Cache API** (deviation, justified above).
3. **Optional Openverse credentials** `OPENVERSE_CLIENT_ID` / `OPENVERSE_CLIENT_SECRET` (deviation: spec lists only Pexels/Pixabay secrets). Without them the Worker runs anonymously at 200 requests/day shared across every Worker on the same egress IP.
4. **Auth = authless + per-IP rate limit, plus optional `MCP_TOKEN`** checked against `Authorization: Bearer …`. No URL token (Anthropic discourages it). Tradeoff documented in the README.
5. **Video ids** carry a `video:` prefix inside `native_id`: `pexels:video:12345`, `pixabay:video:678`. Photo ids stay `pexels:12345`. Pexels photo and video id spaces overlap and use different endpoints, so the type must travel with the id. Parse on the **first** colon only.
6. **`attribution_required`:** Pexels `true` (its API guidelines ask for per-photographer credit), Pixabay `false` (license and API only require the app to show the source; the credit line is still generated).
7. **Unknown licenses** (`sampling+`, `nc-sampling+`, anything unmapped) get code `unknown` with every flag `false`; they appear only when both `commercial_use_only` and `modification_allowed` are `false`.
8. **Orientation:** every provider result is post-filtered by its own width/height (`square` = ratio within ±5 %), because Pixabay has no square filter and no orientation filter for videos. Provider-side params are still sent where they exist.
9. **Pixabay full-resolution URLs** need "full API access"; we use `imageURL ?? fullHDURL ?? largeImageURL` (1280 px for standard keys). Pixabay video: first non-empty of `large, medium, small, tiny`.
10. **Hotlinking:** returning `full_url` for Claude to hand to Canva's upload-from-URL is a one-time fetch, not permanent hotlinking. The README says so and tells integrators not to embed Pixabay URLs directly in pages.
11. **Titles:** Pexels photos use `alt` as title; Pexels and Pixabay videos and Pixabay images have no title field (`null`).
12. **Openverse pre-filter:** `license_type=commercial` / `modification` is sent to Openverse when the corresponding filter is on, to improve yield. The normalized post-filter still runs on every result from every provider.

## Global Constraints

- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, ESM (`"type": "module"`), `moduleResolution: "Bundler"`, extensionless relative imports. `typescript` pinned `^5.9` (npm latest is 7.x and TS ≥ 6 stops auto-including `@types/*`; do not upgrade).
- Dependencies exactly: `@modelcontextprotocol/server ^2.1.0`, `zod ^4.2.0`. Dev: `@modelcontextprotocol/client ^2.1.0`, `@cloudflare/workers-types ^5.20260729.1`, `typescript ^5.9.0`, `vitest ^5.0.0`, `wrangler ^4.115.0`. Nothing else. No `agents`, no `@modelcontextprotocol/sdk` (v1).
- Exactly three tools named `search_media`, `get_media`, `get_attribution`. No resources, no prompts.
- Every outbound request sends `User-Agent: OpenGallery-FreeMediaMCP/0.1 (+https://github.com/pyamzi/OpenGallery)` and aborts after 8 s (`AbortSignal.timeout(8000)`).
- Cache TTLs: Openverse 3600 s, Pexels 3600 s, Pixabay 86400 s. Cache keys are `v1:` + SHA-256 hex of the request URL without API keys.
- No provider JSON leaves the server. Tool results are `JSON.stringify` of `MediaResult`-shaped objects only, no pretty-printing.
- Tests never hit the network: every test file that exercises providers stubs `globalThis.fetch` and calls `vi.unstubAllGlobals()` after each test.
- Secrets only via `.dev.vars` locally and `wrangler secret put` in production: `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `OPENVERSE_CLIENT_ID`, `OPENVERSE_CLIENT_SECRET`, `MCP_TOKEN`. All optional except that with no Pexels key only Openverse answers.
- Commit after every task from the repo root. Commit messages: conventional prefix (`feat:`, `test:`, `chore:`, `docs:`), trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `ponytail:` comments mark deliberate simplifications with a stated ceiling.

## Review Focus

Inputs the spec implies but its tests do not name, most likely to bite first. Each has a pinned test in the task that owns the code.

1. **Malformed or unknown-provider id** (`"abc"`, `"unsplash:1"`, `"pexels:"`, `"pexels:../x"`) to `get_media` / `get_attribution`: `get_media` returns an `isError` text result naming the expected format; `get_attribution` returns a per-id error and still credits the valid ids. (Task 7 `parseId`, Task 5 numeric-id guard, Task 8 tool tests.)
2. **Provider returns 429 or a non-JSON body**: that provider contributes a warning like `pexels: HTTP 429 from api.pexels.com`; the others' results are returned. (Task 7.)
3. **Whitespace-only query, `limit` 0 or 21, `ids` empty**: rejected by the input schema as `isError`, never reaching a provider. (Task 8.)
4. **`providers` names a provider that is not configured or does not support the media type, or nothing is configured**: warning per unavailable provider, `results: []` when none remain, no throw. (Task 7.)
5. **Pexels video with no `video/mp4` file; Pixabay video whose `large.url` is empty**: the Pexels item is skipped, the Pixabay item falls back to the next size. (Tasks 5 and 6.)

## File structure

```
free-media-mcp/
  package.json, tsconfig.json, wrangler.jsonc, vitest.config.ts, .dev.vars.example, .gitignore, README.md
  src/
    env.ts                 Env binding/secret types
    types.ts               ProviderId, MediaType, Orientation, License, MediaResult, Rendition, SearchQuery, Provider
    license.ts             normalizeLicense(), passesFilters(), UNKNOWN_LICENSE   ← the one license module
    attribution.ts         attribution(result, format), withAttribution(partial)
    http.ts                fetchJson() with User-Agent + timeout, HttpError
    cache.ts               cached(kv, keySource, ttl, load), cacheKey()
    providers/openverse.ts image search/get, optional client-credentials token
    providers/pexels.ts    photo + video search/get
    providers/pixabay.ts   image + video search/get
    search.ts              configuredProviders(), searchMedia(), getMedia(), parseId(), interleave(), matchesOrientation()
    server.ts              buildServer(env): McpServer with the three tools and their descriptions
    index.ts               Worker entry: path, token, rate limit, then createMcpHandler
  tests/
    helpers.ts             fakeKv(), fakeEnv(), stubFetch(), jsonResponse()
    fixtures.ts            one realistic object per provider response type
    license.test.ts, attribution.test.ts, http-cache.test.ts,
    openverse.test.ts, pexels.test.ts, pixabay.test.ts, search.test.ts, server.test.ts
```

---

### Task 1: Scaffold, types, and the license module

**Files:**
- Create: `free-media-mcp/package.json`, `free-media-mcp/tsconfig.json`, `free-media-mcp/wrangler.jsonc`, `free-media-mcp/vitest.config.ts`, `free-media-mcp/.dev.vars.example`, `free-media-mcp/.gitignore`, `free-media-mcp/src/env.ts`, `free-media-mcp/src/types.ts`, `free-media-mcp/src/license.ts`
- Test: `free-media-mcp/tests/license.test.ts`

**Interfaces:**
- Produces: every type in `types.ts` below (used by all later tasks); `normalizeLicense(raw: string, opts?: { version?: string | null; url?: string | null }): License`; `passesFilters(license: License, filters: { commercial_use_only: boolean; modification_allowed: boolean }): boolean`; `UNKNOWN_LICENSE: License`; `Env` in `env.ts`.

- [ ] **Step 1: Create the branch and the package scaffold**

From the OpenGallery repo root:

```bash
git checkout -b feat/free-media-mcp
mkdir -p free-media-mcp/src/providers free-media-mcp/tests
```

`free-media-mcp/package.json`:

```json
{
  "name": "opengallery-free-media-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Remote MCP server: search free-license images and videos from Openverse, Pexels, and Pixabay with normalized licenses and attribution.",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "inspector": "npx @modelcontextprotocol/inspector@latest"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.1.0",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20260729.1",
    "@modelcontextprotocol/client": "^2.1.0",
    "typescript": "^5.9.0",
    "vitest": "^5.0.0",
    "wrangler": "^4.115.0"
  }
}
```

`free-media-mcp/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`free-media-mcp/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "opengallery-free-media-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  // Search/detail cache. Create with: npx wrangler kv namespace create MEDIA_CACHE
  // and paste the returned id here. Any placeholder works for `wrangler dev`.
  "kv_namespaces": [{ "binding": "MEDIA_CACHE", "id": "REPLACE_WITH_KV_NAMESPACE_ID" }],
  // Per-IP gate for the authless endpoint. period must be 10 or 60.
  "ratelimits": [{ "name": "RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } }],
  "observability": { "enabled": true }
}
```

`free-media-mcp/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
```

`free-media-mcp/.dev.vars.example`:

```
# Copy to .dev.vars for `wrangler dev`. In production use `wrangler secret put <NAME>`.
PEXELS_API_KEY=
# Optional third provider (https://pixabay.com/api/docs/)
PIXABAY_API_KEY=
# Optional: raises Openverse rate limits (register at https://api.openverse.org/v1/#tag/auth)
OPENVERSE_CLIENT_ID=
OPENVERSE_CLIENT_SECRET=
# Optional: when set, every request must send "Authorization: Bearer <MCP_TOKEN>"
MCP_TOKEN=
```

`free-media-mcp/.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
dist/
```

- [ ] **Step 2: Write `env.ts` and `types.ts`**

`free-media-mcp/src/env.ts`:

```ts
export interface Env {
  PEXELS_API_KEY?: string;
  PIXABAY_API_KEY?: string;
  OPENVERSE_CLIENT_ID?: string;
  OPENVERSE_CLIENT_SECRET?: string;
  MCP_TOKEN?: string;
  MEDIA_CACHE: KVNamespace;
  RATE_LIMITER: RateLimit;
}
```

`free-media-mcp/src/types.ts`:

```ts
import type { Env } from './env';

export const PROVIDER_IDS = ['openverse', 'pexels', 'pixabay'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type MediaType = 'image' | 'video';
export type Orientation = 'landscape' | 'portrait' | 'square' | 'any';

export type LicenseCode =
  | 'cc0' | 'pdm' | 'cc-by' | 'cc-by-sa' | 'cc-by-nd' | 'cc-by-nc' | 'cc-by-nc-sa' | 'cc-by-nc-nd'
  | 'pexels' | 'pixabay' | 'unknown';

export interface License {
  code: LicenseCode;
  name: string;
  url: string | null;
  commercial_use: boolean;
  modification_allowed: boolean;
  attribution_required: boolean;
  share_alike: boolean;
}

export interface Rendition {
  label: string;
  url: string;
  width: number | null;
  height: number | null;
}

export interface MediaResult {
  /** "provider:native_id". Videos on Pexels/Pixabay use "provider:video:native_id". */
  id: string;
  provider: ProviderId;
  media_type: MediaType;
  title: string | null;
  creator: string | null;
  creator_url: string | null;
  source_page_url: string;
  preview_url: string;
  full_url: string;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  license: License;
  attribution_text: string;
  /** Only present on get_media. */
  renditions?: Rendition[];
}

export interface SearchQuery {
  query: string;
  media_type: MediaType;
  orientation: Orientation;
  /** Per-provider page size; the orchestrator trims the interleaved total. */
  limit: number;
  commercial_use_only: boolean;
  modification_allowed: boolean;
}

export interface Provider {
  id: ProviderId;
  supports: readonly MediaType[];
  search(q: SearchQuery, env: Env): Promise<MediaResult[]>;
  /** null = not found. nativeId is everything after the first colon of the unified id. */
  get(nativeId: string, env: Env): Promise<MediaResult | null>;
}
```

- [ ] **Step 3: Write the failing license tests**

`free-media-mcp/tests/license.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeLicense, passesFilters, UNKNOWN_LICENSE } from '../src/license';

const flags = (l: ReturnType<typeof normalizeLicense>) =>
  [l.commercial_use, l.modification_allowed, l.attribution_required, l.share_alike];

describe('normalizeLicense: every code in the rules table', () => {
  it.each([
    // raw, code, [commercial, modification, attribution, share_alike]
    ['cc0', 'cc0', [true, true, false, false]],
    ['pdm', 'pdm', [true, true, false, false]],
    ['by', 'cc-by', [true, true, true, false]],
    ['cc-by', 'cc-by', [true, true, true, false]],
    ['by-sa', 'cc-by-sa', [true, true, true, true]],
    ['by-nd', 'cc-by-nd', [true, false, true, false]],
    ['by-nc', 'cc-by-nc', [false, true, true, false]],
    ['by-nc-sa', 'cc-by-nc-sa', [false, true, true, true]],
    ['by-nc-nd', 'cc-by-nc-nd', [false, false, true, false]],
    ['pexels', 'pexels', [true, true, true, false]],
    ['pixabay', 'pixabay', [true, true, false, false]],
  ] as const)('%s -> %s', (raw, code, expected) => {
    const l = normalizeLicense(raw);
    expect(l.code).toBe(code);
    expect(flags(l)).toEqual(expected);
    expect(l.url).toMatch(/^https:\/\//);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeLicense(' BY-SA ').code).toBe('cc-by-sa');
  });

  it('maps unmapped codes to unknown with every flag false', () => {
    for (const raw of ['sampling+', 'nc-sampling+', '', 'wtfpl']) {
      const l = normalizeLicense(raw);
      expect(l).toEqual(UNKNOWN_LICENSE);
      expect(flags(l)).toEqual([false, false, false, false]);
      expect(l.url).toBeNull();
    }
  });

  it('adds the CC version to the name and prefers the provider license URL', () => {
    const l = normalizeLicense('by', { version: '2.0', url: 'https://creativecommons.org/licenses/by/2.0/' });
    expect(l.name).toBe('CC BY 2.0');
    expect(l.url).toBe('https://creativecommons.org/licenses/by/2.0/');
    expect(normalizeLicense('pexels', { version: '2.0' }).name).toBe('Pexels License');
  });
});

describe('passesFilters', () => {
  const on = { commercial_use_only: true, modification_allowed: true };
  const off = { commercial_use_only: false, modification_allowed: false };

  it('keeps commercial + modifiable licenses under default filters', () => {
    for (const c of ['cc0', 'pdm', 'by', 'by-sa', 'pexels', 'pixabay'])
      expect(passesFilters(normalizeLicense(c), on)).toBe(true);
  });

  it('drops NC under commercial_use_only, ND under modification_allowed, unknown under either', () => {
    expect(passesFilters(normalizeLicense('by-nc'), { commercial_use_only: true, modification_allowed: false })).toBe(false);
    expect(passesFilters(normalizeLicense('by-nd'), { commercial_use_only: false, modification_allowed: true })).toBe(false);
    expect(passesFilters(normalizeLicense('by-nd'), { commercial_use_only: true, modification_allowed: false })).toBe(true);
    expect(passesFilters(UNKNOWN_LICENSE, { commercial_use_only: true, modification_allowed: false })).toBe(false);
    expect(passesFilters(UNKNOWN_LICENSE, { commercial_use_only: false, modification_allowed: true })).toBe(false);
  });

  it('lets everything through when both filters are off', () => {
    for (const c of ['by-nc-nd', 'by-nd', 'sampling+'])
      expect(passesFilters(normalizeLicense(c), off)).toBe(true);
  });
});
```

- [ ] **Step 4: Install and run the test to verify it fails**

```bash
cd free-media-mcp && npm install && npx vitest run tests/license.test.ts
```

Expected: FAIL, `Failed to resolve import "../src/license"`.

- [ ] **Step 5: Write `license.ts`**

`free-media-mcp/src/license.ts`:

```ts
import type { License, LicenseCode } from './types';

const CC = 'https://creativecommons.org';

// Source of truth for the spec's license rules table. Pexels/Pixabay rows come from
// their license pages read on 2026-09-24 (see README "Provider compliance").
const TABLE: Record<Exclude<LicenseCode, 'unknown'>, Omit<License, 'code'>> = {
  cc0:          { name: 'CC0 1.0', url: `${CC}/publicdomain/zero/1.0/`, commercial_use: true, modification_allowed: true, attribution_required: false, share_alike: false },
  pdm:          { name: 'Public Domain Mark 1.0', url: `${CC}/publicdomain/mark/1.0/`, commercial_use: true, modification_allowed: true, attribution_required: false, share_alike: false },
  'cc-by':      { name: 'CC BY', url: `${CC}/licenses/by/4.0/`, commercial_use: true, modification_allowed: true, attribution_required: true, share_alike: false },
  'cc-by-sa':   { name: 'CC BY-SA', url: `${CC}/licenses/by-sa/4.0/`, commercial_use: true, modification_allowed: true, attribution_required: true, share_alike: true },
  'cc-by-nd':   { name: 'CC BY-ND', url: `${CC}/licenses/by-nd/4.0/`, commercial_use: true, modification_allowed: false, attribution_required: true, share_alike: false },
  'cc-by-nc':   { name: 'CC BY-NC', url: `${CC}/licenses/by-nc/4.0/`, commercial_use: false, modification_allowed: true, attribution_required: true, share_alike: false },
  'cc-by-nc-sa': { name: 'CC BY-NC-SA', url: `${CC}/licenses/by-nc-sa/4.0/`, commercial_use: false, modification_allowed: true, attribution_required: true, share_alike: true },
  'cc-by-nc-nd': { name: 'CC BY-NC-ND', url: `${CC}/licenses/by-nc-nd/4.0/`, commercial_use: false, modification_allowed: false, attribution_required: true, share_alike: false },
  pexels:       { name: 'Pexels License', url: 'https://www.pexels.com/license/', commercial_use: true, modification_allowed: true, attribution_required: true, share_alike: false },
  pixabay:      { name: 'Pixabay Content License', url: 'https://pixabay.com/service/license-summary/', commercial_use: true, modification_allowed: true, attribution_required: false, share_alike: false },
};

export const UNKNOWN_LICENSE: License = {
  code: 'unknown', name: 'Unknown license', url: null,
  commercial_use: false, modification_allowed: false, attribution_required: false, share_alike: false,
};

/** Accepts Openverse codes ("by", "by-nc-sa", "cc0", "pdm"), our own ("cc-by"), and provider ids ("pexels", "pixabay"). */
export function normalizeLicense(raw: string, opts: { version?: string | null; url?: string | null } = {}): License {
  const key = raw.trim().toLowerCase();
  const code = key in TABLE ? key : `cc-${key}`;
  const row = TABLE[code as keyof typeof TABLE];
  if (!row) return UNKNOWN_LICENSE;
  const isCc = code.startsWith('cc-');
  return {
    code: code as LicenseCode,
    ...row,
    name: isCc && opts.version ? `${row.name} ${opts.version}` : row.name,
    url: opts.url ?? row.url,
  };
}

export function passesFilters(l: License, f: { commercial_use_only: boolean; modification_allowed: boolean }): boolean {
  if (f.commercial_use_only && !l.commercial_use) return false;
  if (f.modification_allowed && !l.modification_allowed) return false;
  return true;
}
```

- [ ] **Step 6: Run the tests and typecheck**

```bash
cd free-media-mcp && npx vitest run tests/license.test.ts && npm run typecheck
```

Expected: all license tests PASS; `tsc` exits 0 (`index.ts` does not exist yet, that is fine because nothing imports it).

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-09-24-free-media-mcp-spec.md docs/superpowers/plans/2026-09-24-free-media-mcp.md free-media-mcp
git commit -m "feat(free-media-mcp): scaffold worker package, shared types, license module

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Attribution formatting

**Files:**
- Create: `free-media-mcp/src/attribution.ts`
- Test: `free-media-mcp/tests/attribution.test.ts`

**Interfaces:**
- Consumes: `MediaResult`, `License` from Task 1.
- Produces: `type AttributionFormat = 'text' | 'html' | 'markdown'`; `attribution(r: MediaResult, format: AttributionFormat): string`; `withAttribution(r: Omit<MediaResult, 'attribution_text'>): MediaResult` (providers call this last when mapping).

- [ ] **Step 1: Write the failing tests**

`free-media-mcp/tests/attribution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { attribution, withAttribution } from '../src/attribution';
import { normalizeLicense } from '../src/license';
import type { MediaResult } from '../src/types';

const base = {
  media_type: 'image' as const, preview_url: 'p', full_url: 'f', width: 1, height: 1, duration_seconds: null,
};

const cc: MediaResult = withAttribution({
  ...base, id: 'openverse:1', provider: 'openverse',
  title: 'Bride & Groom', creator: 'PiktourUK', creator_url: 'https://www.flickr.com/photos/69706441@N03',
  source_page_url: 'https://www.flickr.com/photos/69706441@N03/33351721606',
  license: normalizeLicense('by', { version: '2.0', url: 'https://creativecommons.org/licenses/by/2.0/' }),
});

const pexels: MediaResult = withAttribution({
  ...base, id: 'pexels:2', provider: 'pexels', title: 'Two people', creator: 'Jane Doe',
  creator_url: 'https://www.pexels.com/@jane', source_page_url: 'https://www.pexels.com/photo/2/',
  license: normalizeLicense('pexels'),
});

const pixabayVideo: MediaResult = withAttribution({
  ...base, id: 'pixabay:video:3', provider: 'pixabay', media_type: 'video', duration_seconds: 12,
  title: null, creator: 'someuser', creator_url: 'https://pixabay.com/users/someuser-99/',
  source_page_url: 'https://pixabay.com/videos/id-3/', license: normalizeLicense('pixabay'),
});

describe('attribution', () => {
  it('text: TASL for CC, provider credit for Pexels/Pixabay, links appended', () => {
    expect(attribution(cc, 'text')).toBe(
      '"Bride & Groom" by PiktourUK is licensed under CC BY 2.0. Source: https://www.flickr.com/photos/69706441@N03/33351721606 License: https://creativecommons.org/licenses/by/2.0/',
    );
    expect(attribution(pexels, 'text')).toBe('Photo by Jane Doe on Pexels (https://www.pexels.com/photo/2/)');
    expect(attribution(pixabayVideo, 'text')).toBe('Video by someuser from Pixabay (https://pixabay.com/videos/id-3/)');
  });

  it('markdown: every element is a link', () => {
    expect(attribution(cc, 'markdown')).toBe(
      '"[Bride & Groom](https://www.flickr.com/photos/69706441@N03/33351721606)" by [PiktourUK](https://www.flickr.com/photos/69706441@N03) is licensed under [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/).',
    );
    expect(attribution(pexels, 'markdown')).toBe('Photo by [Jane Doe](https://www.pexels.com/@jane) on [Pexels](https://www.pexels.com/photo/2/)');
  });

  it('html: anchors with escaped text', () => {
    expect(attribution(cc, 'html')).toBe(
      '"<a href="https://www.flickr.com/photos/69706441@N03/33351721606">Bride &amp; Groom</a>" by <a href="https://www.flickr.com/photos/69706441@N03">PiktourUK</a> is licensed under <a href="https://creativecommons.org/licenses/by/2.0/">CC BY 2.0</a>.',
    );
    expect(attribution(pixabayVideo, 'html')).toBe(
      'Video by <a href="https://pixabay.com/users/someuser-99/">someuser</a> from <a href="https://pixabay.com/videos/id-3/">Pixabay</a>',
    );
  });

  it('falls back when title or creator is missing and never emits a link without a URL', () => {
    const anon = withAttribution({ ...cc, title: null, creator: null, creator_url: null });
    expect(attribution(anon, 'markdown')).toBe(
      '"[Untitled](https://www.flickr.com/photos/69706441@N03/33351721606)" by Unknown creator is licensed under [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/).',
    );
  });

  it('withAttribution sets attribution_text to the text format', () => {
    expect(cc.attribution_text).toBe(attribution(cc, 'text'));
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd free-media-mcp && npx vitest run tests/attribution.test.ts
```

Expected: FAIL, cannot resolve `../src/attribution`.

- [ ] **Step 3: Write `attribution.ts`**

`free-media-mcp/src/attribution.ts`:

```ts
import type { MediaResult } from './types';

export type AttributionFormat = 'text' | 'html' | 'markdown';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function link(text: string, url: string | null, fmt: AttributionFormat): string {
  const t = fmt === 'html' ? escapeHtml(text) : text;
  if (!url || fmt === 'text') return t;
  return fmt === 'html' ? `<a href="${escapeHtml(url)}">${t}</a>` : `[${t}](${url})`;
}

/** One credit line per provider's guidance. CC/public domain uses TASL: Title, Author, Source, License. */
export function attribution(r: MediaResult, fmt: AttributionFormat): string {
  const creator = r.creator ?? 'Unknown creator';
  const text = fmt === 'text';
  if (r.provider === 'pexels') {
    const kind = r.media_type === 'video' ? 'Video' : 'Photo';
    return `${kind} by ${link(creator, r.creator_url, fmt)} on ${link('Pexels', r.source_page_url, fmt)}${text ? ` (${r.source_page_url})` : ''}`;
  }
  if (r.provider === 'pixabay') {
    const kind = r.media_type === 'video' ? 'Video' : 'Image';
    return `${kind} by ${link(creator, r.creator_url, fmt)} from ${link('Pixabay', r.source_page_url, fmt)}${text ? ` (${r.source_page_url})` : ''}`;
  }
  const tail = text ? ` Source: ${r.source_page_url}${r.license.url ? ` License: ${r.license.url}` : ''}` : '';
  return `"${link(r.title ?? 'Untitled', r.source_page_url, fmt)}" by ${link(creator, r.creator_url, fmt)} is licensed under ${link(r.license.name, r.license.url, fmt)}.${tail}`;
}

export function withAttribution(r: Omit<MediaResult, 'attribution_text'>): MediaResult {
  const full = { ...r, attribution_text: '' } as MediaResult;
  full.attribution_text = attribution(full, 'text');
  return full;
}
```

- [ ] **Step 4: Run tests**

```bash
cd free-media-mcp && npx vitest run tests/attribution.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add free-media-mcp/src/attribution.ts free-media-mcp/tests/attribution.test.ts
git commit -m "feat(free-media-mcp): attribution lines in text, markdown, html

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: HTTP fetch helper, KV cache, and test helpers

**Files:**
- Create: `free-media-mcp/src/http.ts`, `free-media-mcp/src/cache.ts`, `free-media-mcp/tests/helpers.ts`
- Test: `free-media-mcp/tests/http-cache.test.ts`

**Interfaces:**
- Produces: `USER_AGENT: string`; `class HttpError extends Error { status: number }`; `fetchJson<T>(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }, timeoutMs?: number): Promise<T>`; `cached<T>(kv: KVNamespace, keySource: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>`; `cacheKey(source: string): Promise<string>`.
- Test helpers: `fakeKv(): KVNamespace & { store: Map<string, string> }`; `fakeEnv(overrides?: Partial<Env>): Env` (Pexels and Pixabay keys set by default); `stubFetch(routes: Record<hostname, Route>): { fn, calls: URL[] }`; `jsonResponse(body: unknown, status?: number): Response`.

- [ ] **Step 1: Write the test helpers**

`free-media-mcp/tests/helpers.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing tests**

`free-media-mcp/tests/http-cache.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cached, cacheKey } from '../src/cache';
import { fetchJson, HttpError, USER_AGENT } from '../src/http';
import { fakeKv, jsonResponse, stubFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('fetchJson', () => {
  it('sends the User-Agent and an abort signal, returns parsed JSON', async () => {
    const { fn } = stubFetch({ 'api.example.com': () => jsonResponse({ ok: 1 }) });
    await expect(fetchJson<{ ok: number }>('https://api.example.com/x')).resolves.toEqual({ ok: 1 });
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws HttpError with the status on non-2xx', async () => {
    stubFetch({ 'api.example.com': () => jsonResponse({ error: 'slow down' }, 429) });
    const err = await fetchJson('https://api.example.com/x').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as Error).message).toBe('HTTP 429 from api.example.com');
  });

  it('rejects on a non-JSON body', async () => {
    stubFetch({ 'api.example.com': () => new Response('<html>oops</html>', { status: 200 }) });
    await expect(fetchJson('https://api.example.com/x')).rejects.toThrow();
  });
});

describe('cached', () => {
  it('loads once, then serves from KV with the TTL', async () => {
    const kv = fakeKv();
    const put = vi.spyOn(kv, 'put');
    const load = vi.fn(async () => ({ n: 1 }));
    expect(await cached(kv, 'https://x/?q=a', 3600, load)).toEqual({ n: 1 });
    expect(await cached(kv, 'https://x/?q=a', 3600, load)).toEqual({ n: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(await cacheKey('https://x/?q=a'), JSON.stringify({ n: 1 }), { expirationTtl: 3600 });
  });

  it('keys are hashed so any source length fits KV limits and differs per source', async () => {
    const a = await cacheKey('https://x/?q=' + 'a'.repeat(5000));
    const b = await cacheKey('https://x/?q=' + 'a'.repeat(5000) + 'b');
    expect(a).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd free-media-mcp && npx vitest run tests/http-cache.test.ts
```

Expected: FAIL, cannot resolve `../src/cache` / `../src/http`.

- [ ] **Step 4: Write `http.ts` and `cache.ts`**

`free-media-mcp/src/http.ts`:

```ts
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
```

`free-media-mcp/src/cache.ts`:

```ts
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
```

- [ ] **Step 5: Run tests**

```bash
cd free-media-mcp && npx vitest run tests/http-cache.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add free-media-mcp/src/http.ts free-media-mcp/src/cache.ts free-media-mcp/tests/helpers.ts free-media-mcp/tests/http-cache.test.ts
git commit -m "feat(free-media-mcp): fetchJson with UA/timeout, KV cache, test helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Openverse provider

**Files:**
- Create: `free-media-mcp/src/providers/openverse.ts`, `free-media-mcp/tests/fixtures.ts`
- Test: `free-media-mcp/tests/openverse.test.ts`

**Interfaces:**
- Consumes: `fetchJson`, `HttpError`, `cached`, `normalizeLicense`, `withAttribution`, `Provider`, `SearchQuery`, `Env`.
- Produces: `openverse: Provider` (`supports: ['image']`), `mapOpenverse(item: OvImage): MediaResult`, `OPENVERSE_TTL = 3600`. Fixtures `OV_IMAGE`, `PX_PHOTO`, `PX_VIDEO`, `PB_IMAGE`, `PB_VIDEO` for Tasks 4–7.

- [ ] **Step 1: Write the shared fixtures**

`free-media-mcp/tests/fixtures.ts` (shapes copied from live/doc responses; trimmed to the fields we read):

```ts
export const OV_IMAGE = {
  id: '575fdc8f-9f62-431c-a24d-9717001ff2ba',
  title: 'Bride and groom in Hanoi',
  foreign_landing_url: 'https://www.flickr.com/photos/69706441@N03/33351721606',
  url: 'https://live.staticflickr.com/752/33351721606_c98d0875a6_b.jpg',
  creator: 'PiktourUK',
  creator_url: 'https://www.flickr.com/photos/69706441@N03',
  license: 'by',
  license_version: '2.0',
  license_url: 'https://creativecommons.org/licenses/by/2.0/',
  provider: 'flickr',
  height: 837,
  width: 1024,
  thumbnail: 'https://api.openverse.org/v1/images/575fdc8f-9f62-431c-a24d-9717001ff2ba/thumb/',
};

export const OV_IMAGE_NC = { ...OV_IMAGE, id: 'nc-1', title: 'NC photo', license: 'by-nc', license_url: 'https://creativecommons.org/licenses/by-nc/2.0/' };

export const PX_PHOTO = {
  id: 2014422,
  width: 3024,
  height: 3024,
  url: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
  photographer: 'Joey Farina',
  photographer_url: 'https://www.pexels.com/@joey',
  alt: 'Brown Rocks During Golden Hour',
  src: {
    original: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg',
    large2x: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940',
    large: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    medium: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=350',
    small: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=130',
    portrait: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800',
    landscape: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200',
    tiny: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280',
  },
};

export const PX_VIDEO = {
  id: 2499611,
  width: 1080,
  height: 1920,
  url: 'https://www.pexels.com/video/2499611/',
  image: 'https://images.pexels.com/videos/2499611/free-video-2499611.jpg?fit=crop&w=1200&h=630',
  duration: 22,
  user: { id: 680589, name: 'Joey Farina', url: 'https://www.pexels.com/@joey' },
  video_files: [
    { id: 1, quality: 'hd', file_type: 'video/mp4', width: 1080, height: 1920, fps: 30, link: 'https://player.vimeo.com/external/hd.mp4' },
    { id: 2, quality: 'sd', file_type: 'video/mp4', width: 540, height: 960, fps: 30, link: 'https://player.vimeo.com/external/sd.mp4' },
    { id: 3, quality: 'hls', file_type: 'video/mp4', width: null, height: null, fps: null, link: 'https://player.vimeo.com/external/hls.m3u8' },
  ],
};

export const PB_IMAGE = {
  id: 195893,
  pageURL: 'https://pixabay.com/en/blossom-bloom-flower-195893/',
  type: 'photo',
  tags: 'blossom, bloom, flower',
  previewURL: 'https://cdn.pixabay.com/photo/2013/10/15/09/12/flower-195893_150.jpg',
  previewWidth: 150,
  previewHeight: 84,
  webformatURL: 'https://pixabay.com/get/35bbf209e13e39d2_640.jpg',
  webformatWidth: 640,
  webformatHeight: 360,
  largeImageURL: 'https://pixabay.com/get/ed6a99fd0a76647_1280.jpg',
  imageWidth: 4000,
  imageHeight: 2250,
  user: 'Josch13',
  user_id: 48777,
};

export const PB_VIDEO = {
  id: 125,
  pageURL: 'https://pixabay.com/videos/id-125/',
  type: 'film',
  tags: 'flowers, yellow, blossom',
  duration: 12,
  videos: {
    large: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.mp4', width: 1920, height: 1080, size: 6615235, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.jpg' },
    medium: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_medium.mp4', width: 1280, height: 720, size: 3562083, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_medium.jpg' },
    small: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_small.mp4', width: 640, height: 360, size: 1030736, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_small.jpg' },
    tiny: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_tiny.mp4', width: 480, height: 270, size: 1030736, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_tiny.jpg' },
  },
  user: 'Coverr-Free-Footage',
  user_id: 1281706,
};
```

- [ ] **Step 2: Write the failing Openverse tests**

`free-media-mcp/tests/openverse.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapOpenverse, openverse } from '../src/providers/openverse';
import { OV_IMAGE } from './fixtures';
import { fakeEnv, jsonResponse, stubFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const q = { query: 'golden hour wedding couple', media_type: 'image' as const, orientation: 'landscape' as const, limit: 8, commercial_use_only: true, modification_allowed: true };

describe('mapOpenverse', () => {
  it('maps fields, id prefix, license with version and provider URL', () => {
    const r = mapOpenverse(OV_IMAGE);
    expect(r).toMatchObject({
      id: 'openverse:575fdc8f-9f62-431c-a24d-9717001ff2ba', provider: 'openverse', media_type: 'image',
      title: 'Bride and groom in Hanoi', creator: 'PiktourUK', creator_url: OV_IMAGE.creator_url,
      source_page_url: OV_IMAGE.foreign_landing_url, preview_url: OV_IMAGE.thumbnail, full_url: OV_IMAGE.url,
      width: 1024, height: 837, duration_seconds: null,
      license: { code: 'cc-by', name: 'CC BY 2.0', url: OV_IMAGE.license_url, attribution_required: true },
    });
    expect(r.attribution_text).toContain('is licensed under CC BY 2.0');
  });
});

describe('openverse.search', () => {
  it('sends q, page_size, aspect_ratio, license_type and mature=false, anonymously by default', async () => {
    const { calls, fn } = stubFetch({ 'api.openverse.org': () => jsonResponse({ results: [OV_IMAGE] }) });
    const out = await openverse.search(q, fakeEnv());
    expect(out).toHaveLength(1);
    const url = calls[0]!;
    expect(url.pathname).toBe('/v1/images/');
    expect(url.searchParams.get('q')).toBe('golden hour wedding couple');
    expect(url.searchParams.get('page_size')).toBe('8');
    expect(url.searchParams.get('aspect_ratio')).toBe('wide');
    expect(url.searchParams.get('license_type')).toBe('commercial,modification');
    expect(url.searchParams.get('mature')).toBe('false');
    const headers = (fn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('omits aspect_ratio for "any" and license_type when both filters are off, clamps q to 200 chars', async () => {
    const { calls } = stubFetch({ 'api.openverse.org': () => jsonResponse({ results: [] }) });
    await openverse.search({ ...q, query: 'x'.repeat(300), orientation: 'any', commercial_use_only: false, modification_allowed: false }, fakeEnv());
    expect(calls[0]!.searchParams.get('aspect_ratio')).toBeNull();
    expect(calls[0]!.searchParams.get('license_type')).toBeNull();
    expect(calls[0]!.searchParams.get('q')).toHaveLength(200);
  });

  it('fetches a bearer token once when client credentials are set, and caches it', async () => {
    const { calls, fn } = stubFetch({
      'api.openverse.org': (url) =>
        url.pathname === '/v1/auth_tokens/token/'
          ? jsonResponse({ access_token: 'tok', expires_in: 43200, token_type: 'Bearer', scope: 'read' })
          : jsonResponse({ results: [OV_IMAGE] }),
    });
    const env = fakeEnv({ OPENVERSE_CLIENT_ID: 'id', OPENVERSE_CLIENT_SECRET: 'sec' });
    await openverse.search(q, env);
    await openverse.search({ ...q, query: 'other' }, env);
    const tokenCalls = calls.filter((u) => u.pathname === '/v1/auth_tokens/token/');
    expect(tokenCalls).toHaveLength(1);
    const tokenInit = fn.mock.calls[0]![1] as RequestInit;
    expect(tokenInit.method).toBe('POST');
    expect((tokenInit.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(String(tokenInit.body)).toBe('client_id=id&client_secret=sec&grant_type=client_credentials');
    const searchInit = fn.mock.calls[1]![1] as RequestInit;
    expect((searchInit.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('serves an identical search from KV without a second fetch', async () => {
    const { fn } = stubFetch({ 'api.openverse.org': () => jsonResponse({ results: [OV_IMAGE] }) });
    const env = fakeEnv();
    await openverse.search(q, env);
    await openverse.search(q, env);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('openverse.get', () => {
  it('returns the item with thumbnail and full renditions', async () => {
    const { calls } = stubFetch({ 'api.openverse.org': () => jsonResponse(OV_IMAGE) });
    const r = await openverse.get(OV_IMAGE.id, fakeEnv());
    expect(calls[0]!.pathname).toBe(`/v1/images/${OV_IMAGE.id}/`);
    expect(r?.renditions).toEqual([
      { label: 'thumbnail', url: OV_IMAGE.thumbnail, width: null, height: null },
      { label: 'full', url: OV_IMAGE.url, width: 1024, height: 837 },
    ]);
  });

  it('returns null on 404 and rethrows other errors', async () => {
    stubFetch({ 'api.openverse.org': () => jsonResponse({ detail: 'Not found.' }, 404) });
    expect(await openverse.get('missing', fakeEnv())).toBeNull();
    vi.unstubAllGlobals();
    stubFetch({ 'api.openverse.org': () => jsonResponse({}, 500) });
    await expect(openverse.get('boom', fakeEnv())).rejects.toThrow('HTTP 500');
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd free-media-mcp && npx vitest run tests/openverse.test.ts
```

Expected: FAIL, cannot resolve `../src/providers/openverse`.

- [ ] **Step 4: Write the provider**

`free-media-mcp/src/providers/openverse.ts`:

```ts
import { withAttribution } from '../attribution';
import { cached } from '../cache';
import type { Env } from '../env';
import { fetchJson, HttpError } from '../http';
import { normalizeLicense } from '../license';
import type { MediaResult, Provider, SearchQuery } from '../types';

const API = 'https://api.openverse.org/v1';
export const OPENVERSE_TTL = 3600;

export interface OvImage {
  id: string;
  title: string | null;
  creator: string | null;
  creator_url: string | null;
  url: string;
  thumbnail: string;
  foreign_landing_url: string;
  license: string;
  license_version: string | null;
  license_url: string | null;
  width: number | null;
  height: number | null;
}

const ASPECT = { landscape: 'wide', portrait: 'tall', square: 'square' } as const;

export function mapOpenverse(i: OvImage): MediaResult {
  return withAttribution({
    id: `openverse:${i.id}`,
    provider: 'openverse',
    media_type: 'image',
    title: i.title || null,
    creator: i.creator || null,
    creator_url: i.creator_url || null,
    source_page_url: i.foreign_landing_url,
    preview_url: i.thumbnail,
    full_url: i.url,
    width: i.width ?? null,
    height: i.height ?? null,
    duration_seconds: null,
    license: normalizeLicense(i.license, { version: i.license_version, url: i.license_url }),
  });
}

/** Anonymous Openverse is 20/min, 200/day per IP and Workers egress IPs are shared; a registered app lifts that. */
async function authHeaders(env: Env): Promise<Record<string, string>> {
  const { OPENVERSE_CLIENT_ID: id, OPENVERSE_CLIENT_SECRET: secret } = env;
  if (!id || !secret) return {};
  let token = await env.MEDIA_CACHE.get<string>('v1:openverse:token', 'json');
  if (!token) {
    const t = await fetchJson<{ access_token: string; expires_in: number }>(`${API}/auth_tokens/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }).toString(),
    });
    token = t.access_token;
    await env.MEDIA_CACHE.put('v1:openverse:token', JSON.stringify(token), { expirationTtl: Math.max(60, t.expires_in - 300) });
  }
  return { Authorization: `Bearer ${token}` };
}

export const openverse: Provider = {
  id: 'openverse',
  supports: ['image'],

  async search(q: SearchQuery, env: Env) {
    const p = new URLSearchParams({ q: q.query.slice(0, 200), page_size: String(q.limit), mature: 'false' });
    if (q.orientation !== 'any') p.set('aspect_ratio', ASPECT[q.orientation]);
    const types = [q.commercial_use_only && 'commercial', q.modification_allowed && 'modification'].filter(Boolean);
    if (types.length) p.set('license_type', types.join(','));
    const url = `${API}/images/?${p}`;
    const data = await cached(env.MEDIA_CACHE, url, OPENVERSE_TTL, async () =>
      fetchJson<{ results: OvImage[] }>(url, { headers: await authHeaders(env) }),
    );
    return data.results.map(mapOpenverse);
  },

  async get(nativeId: string, env: Env) {
    const url = `${API}/images/${encodeURIComponent(nativeId)}/`;
    try {
      const i = await cached(env.MEDIA_CACHE, url, OPENVERSE_TTL, async () => fetchJson<OvImage>(url, { headers: await authHeaders(env) }));
      const r = mapOpenverse(i);
      return {
        ...r,
        renditions: [
          { label: 'thumbnail', url: i.thumbnail, width: null, height: null },
          { label: 'full', url: i.url, width: r.width, height: r.height },
        ],
      };
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  },
};
```

- [ ] **Step 5: Run tests**

```bash
cd free-media-mcp && npx vitest run tests/openverse.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add free-media-mcp/src/providers/openverse.ts free-media-mcp/tests/openverse.test.ts free-media-mcp/tests/fixtures.ts
git commit -m "feat(free-media-mcp): Openverse image provider with optional client-credentials auth

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Pexels provider (photos and videos)

**Files:**
- Create: `free-media-mcp/src/providers/pexels.ts`
- Test: `free-media-mcp/tests/pexels.test.ts`

**Interfaces:**
- Produces: `pexels: Provider` (`supports: ['image', 'video']`), `mapPexelsPhoto(p: PxPhoto): MediaResult`, `mapPexelsVideo(v: PxVideo): MediaResult | null`, `PEXELS_TTL = 3600`. Video native ids are `video:<id>`.

- [ ] **Step 1: Write the failing tests**

`free-media-mcp/tests/pexels.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapPexelsPhoto, mapPexelsVideo, pexels } from '../src/providers/pexels';
import { PX_PHOTO, PX_VIDEO } from './fixtures';
import { fakeEnv, jsonResponse, stubFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const q = { query: 'golden hour wedding couple', media_type: 'image' as const, orientation: 'portrait' as const, limit: 5, commercial_use_only: true, modification_allowed: true };

describe('mapping', () => {
  it('photo: alt as title, original as full, medium as preview, pexels license', () => {
    expect(mapPexelsPhoto(PX_PHOTO)).toMatchObject({
      id: 'pexels:2014422', provider: 'pexels', media_type: 'image', title: 'Brown Rocks During Golden Hour',
      creator: 'Joey Farina', creator_url: 'https://www.pexels.com/@joey', source_page_url: PX_PHOTO.url,
      preview_url: PX_PHOTO.src.medium, full_url: PX_PHOTO.src.original, width: 3024, height: 3024, duration_seconds: null,
      license: { code: 'pexels', attribution_required: true, commercial_use: true },
      attribution_text: 'Photo by Joey Farina on Pexels (https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/)',
    });
  });

  it('video: largest mp4 as full, poster image as preview, video: id prefix, duration', () => {
    expect(mapPexelsVideo(PX_VIDEO)).toMatchObject({
      id: 'pexels:video:2499611', media_type: 'video', title: null, creator: 'Joey Farina',
      preview_url: PX_VIDEO.image, full_url: 'https://player.vimeo.com/external/hd.mp4', width: 1080, height: 1920, duration_seconds: 22,
    });
  });

  it('video without any video/mp4 file is dropped (null)', () => {
    expect(mapPexelsVideo({ ...PX_VIDEO, video_files: [{ ...PX_VIDEO.video_files[2]!, file_type: 'application/x-mpegURL' }] })).toBeNull();
  });
});

describe('pexels.search', () => {
  it('images: /v1/search with Authorization, query, per_page, orientation', async () => {
    const { calls, fn } = stubFetch({ 'api.pexels.com': () => jsonResponse({ photos: [PX_PHOTO] }) });
    const out = await pexels.search(q, fakeEnv());
    expect(out.map((r) => r.id)).toEqual(['pexels:2014422']);
    expect(calls[0]!.pathname).toBe('/v1/search');
    expect(calls[0]!.searchParams.get('query')).toBe('golden hour wedding couple');
    expect(calls[0]!.searchParams.get('per_page')).toBe('5');
    expect(calls[0]!.searchParams.get('orientation')).toBe('portrait');
    expect(((fn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).Authorization).toBe('pexels-test-key');
  });

  it('videos: /videos/search, drops items without mp4', async () => {
    stubFetch({ 'api.pexels.com': () => jsonResponse({ videos: [PX_VIDEO, { ...PX_VIDEO, id: 9, video_files: [] }] }) });
    const out = await pexels.search({ ...q, media_type: 'video', orientation: 'any' }, fakeEnv());
    expect(out.map((r) => r.id)).toEqual(['pexels:video:2499611']);
  });
});

describe('pexels.get', () => {
  it('photo id -> /v1/photos/:id with all src renditions', async () => {
    const { calls } = stubFetch({ 'api.pexels.com': () => jsonResponse(PX_PHOTO) });
    const r = await pexels.get('2014422', fakeEnv());
    expect(calls[0]!.pathname).toBe('/v1/photos/2014422');
    expect(r?.renditions?.map((x) => x.label)).toEqual(['original', 'large2x', 'large', 'medium', 'small', 'portrait', 'landscape', 'tiny']);
    expect(r?.renditions?.[0]).toEqual({ label: 'original', url: PX_PHOTO.src.original, width: 3024, height: 3024 });
  });

  it('video:id -> /videos/videos/:id with one rendition per mp4 file', async () => {
    const { calls } = stubFetch({ 'api.pexels.com': () => jsonResponse(PX_VIDEO) });
    const r = await pexels.get('video:2499611', fakeEnv());
    expect(calls[0]!.pathname).toBe('/videos/videos/2499611');
    expect(r?.renditions).toEqual([
      { label: 'hd 1080x1920', url: 'https://player.vimeo.com/external/hd.mp4', width: 1080, height: 1920 },
      { label: 'sd 540x960', url: 'https://player.vimeo.com/external/sd.mp4', width: 540, height: 960 },
    ]);
  });

  it('non-numeric ids never reach the network; 404 -> null', async () => {
    const { fn } = stubFetch({ 'api.pexels.com': () => jsonResponse({}, 404) });
    expect(await pexels.get('../etc', fakeEnv())).toBeNull();
    expect(await pexels.get('video:abc', fakeEnv())).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(await pexels.get('1', fakeEnv())).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd free-media-mcp && npx vitest run tests/pexels.test.ts
```

Expected: FAIL, cannot resolve `../src/providers/pexels`.

- [ ] **Step 3: Write the provider**

`free-media-mcp/src/providers/pexels.ts`:

```ts
import { withAttribution } from '../attribution';
import { cached } from '../cache';
import type { Env } from '../env';
import { fetchJson, HttpError } from '../http';
import { normalizeLicense } from '../license';
import type { MediaResult, Provider, Rendition, SearchQuery } from '../types';

const API = 'https://api.pexels.com';
export const PEXELS_TTL = 3600;

export interface PxPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt: string | null;
  src: Record<'original' | 'large2x' | 'large' | 'medium' | 'small' | 'portrait' | 'landscape' | 'tiny', string>;
}

export interface PxVideoFile {
  quality: string;
  file_type: string;
  width: number | null;
  height: number | null;
  link: string;
}

export interface PxVideo {
  id: number;
  width: number;
  height: number;
  url: string;
  image: string;
  duration: number;
  user: { name: string; url: string };
  video_files: PxVideoFile[];
}

const mp4s = (v: PxVideo) =>
  v.video_files.filter((f) => f.file_type === 'video/mp4' && f.width !== null).sort((a, b) => (b.width ?? 0) - (a.width ?? 0));

export function mapPexelsPhoto(p: PxPhoto): MediaResult {
  return withAttribution({
    id: `pexels:${p.id}`,
    provider: 'pexels',
    media_type: 'image',
    title: p.alt || null,
    creator: p.photographer,
    creator_url: p.photographer_url,
    source_page_url: p.url,
    preview_url: p.src.medium,
    full_url: p.src.original,
    width: p.width,
    height: p.height,
    duration_seconds: null,
    license: normalizeLicense('pexels'),
  });
}

export function mapPexelsVideo(v: PxVideo): MediaResult | null {
  const best = mp4s(v)[0];
  if (!best) return null;
  return withAttribution({
    id: `pexels:video:${v.id}`,
    provider: 'pexels',
    media_type: 'video',
    title: null,
    creator: v.user.name,
    creator_url: v.user.url,
    source_page_url: v.url,
    preview_url: v.image,
    full_url: best.link,
    width: v.width,
    height: v.height,
    duration_seconds: v.duration,
    license: normalizeLicense('pexels'),
  });
}

const photoRenditions = (p: PxPhoto): Rendition[] =>
  (Object.keys(p.src) as (keyof PxPhoto['src'])[]).map((label) => ({
    label,
    url: p.src[label],
    width: label === 'original' ? p.width : null,
    height: label === 'original' ? p.height : null,
  }));

const videoRenditions = (v: PxVideo): Rendition[] =>
  mp4s(v).map((f) => ({ label: `${f.quality} ${f.width}x${f.height}`, url: f.link, width: f.width, height: f.height }));

const headers = (env: Env) => ({ Authorization: env.PEXELS_API_KEY ?? '' });

export const pexels: Provider = {
  id: 'pexels',
  supports: ['image', 'video'],

  async search(q: SearchQuery, env: Env) {
    const p = new URLSearchParams({ query: q.query, per_page: String(q.limit) });
    if (q.orientation !== 'any') p.set('orientation', q.orientation);
    if (q.media_type === 'video') {
      const url = `${API}/videos/search?${p}`;
      const d = await cached(env.MEDIA_CACHE, url, PEXELS_TTL, () => fetchJson<{ videos: PxVideo[] }>(url, { headers: headers(env) }));
      return d.videos.map(mapPexelsVideo).filter((r): r is MediaResult => r !== null);
    }
    const url = `${API}/v1/search?${p}`;
    const d = await cached(env.MEDIA_CACHE, url, PEXELS_TTL, () => fetchJson<{ photos: PxPhoto[] }>(url, { headers: headers(env) }));
    return d.photos.map(mapPexelsPhoto);
  },

  async get(nativeId: string, env: Env) {
    const video = nativeId.startsWith('video:');
    const num = video ? nativeId.slice('video:'.length) : nativeId;
    if (!/^\d+$/.test(num)) return null;
    try {
      if (video) {
        const url = `${API}/videos/videos/${num}`;
        const v = await cached(env.MEDIA_CACHE, url, PEXELS_TTL, () => fetchJson<PxVideo>(url, { headers: headers(env) }));
        const r = mapPexelsVideo(v);
        return r && { ...r, renditions: videoRenditions(v) };
      }
      const url = `${API}/v1/photos/${num}`;
      const p = await cached(env.MEDIA_CACHE, url, PEXELS_TTL, () => fetchJson<PxPhoto>(url, { headers: headers(env) }));
      return { ...mapPexelsPhoto(p), renditions: photoRenditions(p) };
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  },
};
```

- [ ] **Step 4: Run tests**

```bash
cd free-media-mcp && npx vitest run tests/pexels.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add free-media-mcp/src/providers/pexels.ts free-media-mcp/tests/pexels.test.ts
git commit -m "feat(free-media-mcp): Pexels photo and video provider

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Pixabay provider (images and videos, 24 h cache)

**Files:**
- Create: `free-media-mcp/src/providers/pixabay.ts`
- Test: `free-media-mcp/tests/pixabay.test.ts`

**Interfaces:**
- Produces: `pixabay: Provider` (`supports: ['image', 'video']`), `mapPixabayImage(h: PbImage): MediaResult`, `mapPixabayVideo(h: PbVideo): MediaResult | null`, `PIXABAY_TTL = 86400`. Video native ids are `video:<id>`.

- [ ] **Step 1: Write the failing tests**

`free-media-mcp/tests/pixabay.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheKey } from '../src/cache';
import { mapPixabayImage, mapPixabayVideo, pixabay, PIXABAY_TTL } from '../src/providers/pixabay';
import { PB_IMAGE, PB_VIDEO } from './fixtures';
import { fakeEnv, jsonResponse, stubFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const q = { query: 'blossom', media_type: 'image' as const, orientation: 'landscape' as const, limit: 2, commercial_use_only: true, modification_allowed: true };

describe('mapping', () => {
  it('image: largeImageURL as full (scaled dims), webformat as preview, no title, user page as creator_url', () => {
    expect(mapPixabayImage(PB_IMAGE)).toMatchObject({
      id: 'pixabay:195893', provider: 'pixabay', media_type: 'image', title: null, creator: 'Josch13',
      creator_url: 'https://pixabay.com/users/Josch13-48777/', source_page_url: PB_IMAGE.pageURL,
      preview_url: PB_IMAGE.webformatURL, full_url: PB_IMAGE.largeImageURL, width: 1280, height: 720,
      license: { code: 'pixabay', attribution_required: false, commercial_use: true },
      attribution_text: 'Image by Josch13 from Pixabay (https://pixabay.com/en/blossom-bloom-flower-195893/)',
    });
  });

  it('image: prefers imageURL, then fullHDURL, with their real dimensions', () => {
    expect(mapPixabayImage({ ...PB_IMAGE, imageURL: 'https://x/full.jpg' })).toMatchObject({ full_url: 'https://x/full.jpg', width: 4000, height: 2250 });
    expect(mapPixabayImage({ ...PB_IMAGE, fullHDURL: 'https://x/hd.jpg' })).toMatchObject({ full_url: 'https://x/hd.jpg', width: 1920, height: 1080 });
  });

  it('video: large as full, falls back to the next non-empty size, dropped when all empty', () => {
    expect(mapPixabayVideo(PB_VIDEO)).toMatchObject({
      id: 'pixabay:video:125', media_type: 'video', full_url: PB_VIDEO.videos.large.url, width: 1920, height: 1080,
      preview_url: PB_VIDEO.videos.medium.thumbnail, duration_seconds: 12, creator: 'Coverr-Free-Footage',
    });
    const noLarge = { ...PB_VIDEO, videos: { ...PB_VIDEO.videos, large: { ...PB_VIDEO.videos.large, url: '' } } };
    expect(mapPixabayVideo(noLarge)).toMatchObject({ full_url: PB_VIDEO.videos.medium.url, width: 1280, height: 720 });
    const empty = { ...PB_VIDEO, videos: Object.fromEntries(Object.entries(PB_VIDEO.videos).map(([k, v]) => [k, { ...v, url: '' }])) as typeof PB_VIDEO.videos };
    expect(mapPixabayVideo(empty)).toBeNull();
  });
});

describe('pixabay.search', () => {
  it('images: key, q (≤100 chars), per_page ≥ 3, orientation=horizontal, safesearch', async () => {
    const { calls } = stubFetch({ 'pixabay.com': () => jsonResponse({ hits: [PB_IMAGE] }) });
    await pixabay.search({ ...q, query: 'y'.repeat(150) }, fakeEnv());
    const url = calls[0]!;
    expect(url.pathname).toBe('/api/');
    expect(url.searchParams.get('key')).toBe('pixabay-test-key');
    expect(url.searchParams.get('q')).toHaveLength(100);
    expect(url.searchParams.get('per_page')).toBe('3');
    expect(url.searchParams.get('orientation')).toBe('horizontal');
    expect(url.searchParams.get('safesearch')).toBe('true');
  });

  it('videos: /api/videos/ without orientation; square sends no orientation', async () => {
    const { calls } = stubFetch({ 'pixabay.com': (url) => jsonResponse({ hits: url.pathname === '/api/videos/' ? [PB_VIDEO] : [PB_IMAGE] }) });
    const out = await pixabay.search({ ...q, media_type: 'video', orientation: 'portrait' }, fakeEnv());
    expect(out.map((r) => r.id)).toEqual(['pixabay:video:125']);
    expect(calls[0]!.pathname).toBe('/api/videos/');
    expect(calls[0]!.searchParams.get('orientation')).toBeNull();
    await pixabay.search({ ...q, orientation: 'square' }, fakeEnv());
    expect(calls[1]!.searchParams.get('orientation')).toBeNull();
  });

  it('caches for 24 h under a key that excludes the API key', async () => {
    stubFetch({ 'pixabay.com': () => jsonResponse({ hits: [PB_IMAGE] }) });
    const env = fakeEnv();
    const put = vi.spyOn(env.MEDIA_CACHE, 'put');
    await pixabay.search(q, env);
    expect(put).toHaveBeenCalledWith(expect.any(String), expect.any(String), { expirationTtl: PIXABAY_TTL });
    // The key is the hash of the request URL *without* the key param (param order as built by the provider).
    expect(put.mock.calls[0]![0]).toBe(await cacheKey('https://pixabay.com/api/?q=blossom&per_page=3&safesearch=true&orientation=horizontal'));
  });
});

describe('pixabay.get', () => {
  it('image and video by id param; empty hits -> null; non-numeric never fetches', async () => {
    const { calls, fn } = stubFetch({ 'pixabay.com': (url) => jsonResponse({ hits: url.pathname === '/api/videos/' ? [PB_VIDEO] : [] }) });
    expect(await pixabay.get('195893', fakeEnv())).toBeNull();
    expect(calls[0]!.searchParams.get('id')).toBe('195893');
    const v = await pixabay.get('video:125', fakeEnv());
    expect(calls[1]!.pathname).toBe('/api/videos/');
    expect(v?.renditions).toEqual([
      { label: 'large', url: PB_VIDEO.videos.large.url, width: 1920, height: 1080 },
      { label: 'medium', url: PB_VIDEO.videos.medium.url, width: 1280, height: 720 },
      { label: 'small', url: PB_VIDEO.videos.small.url, width: 640, height: 360 },
      { label: 'tiny', url: PB_VIDEO.videos.tiny.url, width: 480, height: 270 },
    ]);
    expect(await pixabay.get('x;drop', fakeEnv())).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('image renditions list preview, webformat, large (and hd/full when present)', async () => {
    stubFetch({ 'pixabay.com': () => jsonResponse({ hits: [{ ...PB_IMAGE, fullHDURL: 'https://x/hd.jpg' }] }) });
    const r = await pixabay.get('195893', fakeEnv());
    expect(r?.renditions).toEqual([
      { label: 'preview', url: PB_IMAGE.previewURL, width: 150, height: 84 },
      { label: 'webformat', url: PB_IMAGE.webformatURL, width: 640, height: 360 },
      { label: 'large', url: PB_IMAGE.largeImageURL, width: 1280, height: 720 },
      { label: 'fullhd', url: 'https://x/hd.jpg', width: 1920, height: 1080 },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd free-media-mcp && npx vitest run tests/pixabay.test.ts
```

Expected: FAIL, cannot resolve `../src/providers/pixabay`.

- [ ] **Step 3: Write the provider**

`free-media-mcp/src/providers/pixabay.ts`:

```ts
import { withAttribution } from '../attribution';
import { cached } from '../cache';
import type { Env } from '../env';
import { fetchJson, HttpError } from '../http';
import { normalizeLicense } from '../license';
import type { MediaResult, Provider, Rendition, SearchQuery } from '../types';

const API = 'https://pixabay.com/api';
/** Pixabay API terms: "requests must be cached for 24 hours". */
export const PIXABAY_TTL = 86400;

export interface PbImage {
  id: number;
  pageURL: string;
  previewURL: string;
  previewWidth: number;
  previewHeight: number;
  webformatURL: string;
  webformatWidth: number;
  webformatHeight: number;
  largeImageURL: string;
  fullHDURL?: string;
  imageURL?: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
  user_id: number;
}

export interface PbVideoFile {
  url: string;
  width: number;
  height: number;
  thumbnail: string;
}

export interface PbVideo {
  id: number;
  pageURL: string;
  duration: number;
  videos: Record<'large' | 'medium' | 'small' | 'tiny', PbVideoFile>;
  user: string;
  user_id: number;
}

const userUrl = (h: { user: string; user_id: number }) => `https://pixabay.com/users/${h.user}-${h.user_id}/`;

/** Pixabay's derived sizes are the original scaled so the longer edge equals `max`. */
const scaled = (w: number, h: number, max: number) => {
  const f = max / Math.max(w, h);
  return { width: Math.round(w * f), height: Math.round(h * f) };
};

function imageRenditions(h: PbImage): Rendition[] {
  const out: Rendition[] = [
    { label: 'preview', url: h.previewURL, width: h.previewWidth, height: h.previewHeight },
    { label: 'webformat', url: h.webformatURL, width: h.webformatWidth, height: h.webformatHeight },
    { label: 'large', url: h.largeImageURL, ...scaled(h.imageWidth, h.imageHeight, 1280) },
  ];
  if (h.fullHDURL) out.push({ label: 'fullhd', url: h.fullHDURL, ...scaled(h.imageWidth, h.imageHeight, 1920) });
  if (h.imageURL) out.push({ label: 'original', url: h.imageURL, width: h.imageWidth, height: h.imageHeight });
  return out;
}

export function mapPixabayImage(h: PbImage): MediaResult {
  const full = imageRenditions(h).at(-1)!; // best available; fullHD/original need "full API access"
  return withAttribution({
    id: `pixabay:${h.id}`,
    provider: 'pixabay',
    media_type: 'image',
    title: null,
    creator: h.user,
    creator_url: userUrl(h),
    source_page_url: h.pageURL,
    preview_url: h.webformatURL,
    full_url: full.url,
    width: full.width,
    height: full.height,
    duration_seconds: null,
    license: normalizeLicense('pixabay'),
  });
}

const videoRenditions = (v: PbVideo): Rendition[] =>
  (['large', 'medium', 'small', 'tiny'] as const)
    .filter((k) => v.videos[k].url)
    .map((k) => ({ label: k, url: v.videos[k].url, width: v.videos[k].width, height: v.videos[k].height }));

export function mapPixabayVideo(v: PbVideo): MediaResult | null {
  const best = videoRenditions(v)[0];
  if (!best) return null;
  return withAttribution({
    id: `pixabay:video:${v.id}`,
    provider: 'pixabay',
    media_type: 'video',
    title: null,
    creator: v.user,
    creator_url: userUrl(v),
    source_page_url: v.pageURL,
    preview_url: v.videos.medium.thumbnail || v.videos.tiny.thumbnail,
    full_url: best.url,
    width: best.width,
    height: best.height,
    duration_seconds: v.duration,
    license: normalizeLicense('pixabay'),
  });
}

const ORIENTATION = { landscape: 'horizontal', portrait: 'vertical' } as const;

/** Builds the URL twice: the cache key must not contain the API key. */
async function hits<T>(env: Env, path: '/' | '/videos/', params: URLSearchParams): Promise<T[]> {
  const keySource = `${API}${path}?${params}`;
  params.set('key', env.PIXABAY_API_KEY ?? '');
  const url = `${API}${path}?${params}`;
  return (await cached(env.MEDIA_CACHE, keySource, PIXABAY_TTL, () => fetchJson<{ hits: T[] }>(url))).hits;
}

export const pixabay: Provider = {
  id: 'pixabay',
  supports: ['image', 'video'],

  async search(q: SearchQuery, env: Env) {
    const p = new URLSearchParams({ q: q.query.slice(0, 100), per_page: String(Math.max(3, q.limit)), safesearch: 'true' });
    if (q.media_type === 'video') return (await hits<PbVideo>(env, '/videos/', p)).map(mapPixabayVideo).filter((r): r is MediaResult => r !== null);
    if (q.orientation === 'landscape' || q.orientation === 'portrait') p.set('orientation', ORIENTATION[q.orientation]);
    return (await hits<PbImage>(env, '/', p)).map(mapPixabayImage);
  },

  async get(nativeId: string, env: Env) {
    const video = nativeId.startsWith('video:');
    const num = video ? nativeId.slice('video:'.length) : nativeId;
    if (!/^\d+$/.test(num)) return null;
    try {
      const p = new URLSearchParams({ id: num });
      if (video) {
        const v = (await hits<PbVideo>(env, '/videos/', p))[0];
        const r = v && mapPixabayVideo(v);
        return r ? { ...r, renditions: videoRenditions(v) } : null;
      }
      const h = (await hits<PbImage>(env, '/', p))[0];
      return h ? { ...mapPixabayImage(h), renditions: imageRenditions(h) } : null;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 404)) return null; // Pixabay answers 400 for unknown ids
      throw e;
    }
  },
};
```

- [ ] **Step 4: Run tests**

```bash
cd free-media-mcp && npx vitest run tests/pixabay.test.ts && npm run typecheck
```

Expected: PASS. If the "excludes the API key" assertion fails, check that `hits()` computes `keySource` before `params.set('key', …)`.

- [ ] **Step 5: Commit**

```bash
git add free-media-mcp/src/providers/pixabay.ts free-media-mcp/tests/pixabay.test.ts
git commit -m "feat(free-media-mcp): Pixabay image and video provider with 24h cache

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Search orchestration and lookups

**Files:**
- Create: `free-media-mcp/src/search.ts`
- Test: `free-media-mcp/tests/search.test.ts`

**Interfaces:**
- Consumes: the three providers, `passesFilters`, `PROVIDER_IDS`.
- Produces: `configuredProviders(env: Env): Provider[]`; `interface SearchInput { query: string; media_type: MediaType; commercial_use_only: boolean; modification_allowed: boolean; orientation: Orientation; providers?: ProviderId[]; limit: number }`; `interface SearchOutput { results: MediaResult[]; warnings: string[] }`; `searchMedia(input: SearchInput, env: Env, providers?: Provider[]): Promise<SearchOutput>`; `parseId(id: string): { provider: ProviderId; nativeId: string } | null`; `getMedia(id: string, env: Env, providers?: Provider[]): Promise<MediaResult>` (throws `Error` with a user-readable message); `interleave<T>(lists: T[][], limit: number): T[]`; `matchesOrientation(w, h, o): boolean`; `errorMessage(e: unknown): string`.

- [ ] **Step 1: Write the failing tests**

`free-media-mcp/tests/search.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredProviders, getMedia, interleave, matchesOrientation, parseId, searchMedia } from '../src/search';
import { OV_IMAGE, OV_IMAGE_NC, PB_IMAGE, PX_PHOTO, PX_VIDEO } from './fixtures';
import { fakeEnv, jsonResponse, stubFetch, type Route } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const input = { query: 'golden hour wedding couple', media_type: 'image' as const, commercial_use_only: true, modification_allowed: true, orientation: 'any' as const, limit: 8 };

const allOk = (): Record<string, Route> => ({
  'api.openverse.org': () => jsonResponse({ results: [OV_IMAGE, OV_IMAGE_NC, { ...OV_IMAGE, id: 'ov3', title: 'third' }] }),
  'api.pexels.com': (url) => jsonResponse(url.pathname.startsWith('/videos') ? { videos: [PX_VIDEO] } : { photos: [PX_PHOTO, { ...PX_PHOTO, id: 2 }] }),
  'pixabay.com': () => jsonResponse({ hits: [PB_IMAGE] }),
});

describe('configuredProviders', () => {
  it('always includes Openverse; Pexels/Pixabay only with keys', () => {
    expect(configuredProviders(fakeEnv()).map((p) => p.id)).toEqual(['openverse', 'pexels', 'pixabay']);
    expect(configuredProviders(fakeEnv({ PEXELS_API_KEY: undefined, PIXABAY_API_KEY: undefined })).map((p) => p.id)).toEqual(['openverse']);
  });
});

describe('searchMedia', () => {
  it('queries providers in parallel (all requests in flight before any resolves)', async () => {
    // Each provider awaits a KV read and a SHA-256 before fetching, so the start ORDER is not deterministic.
    // Every route serves its own correct body and all three block on one shared gate.
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const body: Record<string, unknown> = {
      'api.openverse.org': { results: [OV_IMAGE] },
      'api.pexels.com': { photos: [PX_PHOTO] },
      'pixabay.com': { hits: [PB_IMAGE] },
    };
    const routes: Record<string, Route> = Object.fromEntries(
      Object.keys(body).map((host) => [host, async () => { started.push(host); await gate; return jsonResponse(body[host]); }]),
    );
    stubFetch(routes);
    const promise = searchMedia(input, fakeEnv());
    await vi.waitFor(() => expect(started).toHaveLength(3));
    release();
    const out = await promise;
    expect(out.results).toHaveLength(3);
    expect(out.warnings).toEqual([]);
  });

  it('interleaves providers, filters NC after normalization, respects limit', async () => {
    stubFetch(allOk());
    const out = await searchMedia({ ...input, limit: 4 }, fakeEnv());
    expect(out.results.map((r) => r.id)).toEqual(['openverse:575fdc8f-9f62-431c-a24d-9717001ff2ba', 'pexels:2014422', 'pixabay:195893', 'openverse:ov3']);
    expect(out.results.some((r) => r.license.code === 'cc-by-nc')).toBe(false);
  });

  it('one provider erroring (HTTP 429) still returns the others plus a warning', async () => {
    stubFetch({ ...allOk(), 'api.pexels.com': () => jsonResponse({ error: 'limit' }, 429) });
    const out = await searchMedia(input, fakeEnv());
    expect(out.results.map((r) => r.provider)).toEqual(['openverse', 'pixabay', 'openverse']);
    expect(out.warnings).toEqual(['pexels: HTTP 429 from api.pexels.com']);
  });

  it('a non-JSON provider body becomes a warning, not a failure', async () => {
    stubFetch({ ...allOk(), 'pixabay.com': () => new Response('<html>', { status: 200 }) });
    const out = await searchMedia(input, fakeEnv());
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/^pixabay: /);
  });

  it('video queries never touch Openverse', async () => {
    const { calls } = stubFetch(allOk());
    const out = await searchMedia({ ...input, media_type: 'video' }, fakeEnv());
    expect(calls.map((u) => u.hostname)).not.toContain('api.openverse.org');
    expect(out.results.map((r) => r.id)).toEqual(['pexels:video:2499611']);
  });

  it('providers filter: unknown/unsupported/unconfigured entries warn; none left -> empty results', async () => {
    const { calls } = stubFetch(allOk());
    const out = await searchMedia({ ...input, media_type: 'video', providers: ['openverse', 'pixabay'] }, fakeEnv({ PIXABAY_API_KEY: undefined }));
    expect(calls).toHaveLength(0);
    expect(out.results).toEqual([]);
    expect(out.warnings).toEqual(['openverse: not configured or does not support video', 'pixabay: not configured or does not support video', 'no providers available for this query']);
  });

  it('orientation is enforced on every provider by dimensions (square Pixabay result kept, landscape dropped)', async () => {
    stubFetch({ ...allOk(), 'pixabay.com': () => jsonResponse({ hits: [PB_IMAGE, { ...PB_IMAGE, id: 7, imageWidth: 1000, imageHeight: 1000 }] }) });
    const out = await searchMedia({ ...input, orientation: 'square', providers: ['pixabay'] }, fakeEnv());
    expect(out.results.map((r) => r.id)).toEqual(['pixabay:7']);
  });

  it('trims the query before use', async () => {
    const { calls } = stubFetch(allOk());
    await searchMedia({ ...input, query: '  sunset  ', providers: ['openverse'] }, fakeEnv());
    expect(calls[0]!.searchParams.get('q')).toBe('sunset');
  });
});

describe('helpers', () => {
  it('interleave round-robins and stops at limit', () => {
    expect(interleave([[1, 2, 3], ['a'], ['x', 'y']], 5)).toEqual([1, 'a', 'x', 2, 'y']);
    expect(interleave([[], []], 3)).toEqual([]);
  });

  it('matchesOrientation', () => {
    expect(matchesOrientation(1920, 1080, 'landscape')).toBe(true);
    expect(matchesOrientation(1080, 1920, 'landscape')).toBe(false);
    expect(matchesOrientation(1000, 1030, 'square')).toBe(true);
    expect(matchesOrientation(null, null, 'portrait')).toBe(true);
    expect(matchesOrientation(1, 2, 'any')).toBe(true);
  });

  it('parseId splits on the first colon and rejects garbage', () => {
    expect(parseId('pexels:video:12')).toEqual({ provider: 'pexels', nativeId: 'video:12' });
    expect(parseId('openverse:abc')).toEqual({ provider: 'openverse', nativeId: 'abc' });
    for (const bad of ['abc', 'unsplash:1', 'pexels:', ':1', ''])
      expect(parseId(bad)).toBeNull();
  });
});

describe('getMedia', () => {
  it('routes to the provider and returns renditions', async () => {
    stubFetch({ 'api.pexels.com': () => jsonResponse(PX_PHOTO) });
    const r = await getMedia('pexels:2014422', fakeEnv());
    expect(r.renditions?.length).toBe(8);
  });

  it('readable errors for bad id, unconfigured provider, and not found', async () => {
    stubFetch({ 'api.openverse.org': () => jsonResponse({}, 404) });
    await expect(getMedia('nope', fakeEnv())).rejects.toThrow('invalid id "nope", expected "provider:native_id"');
    await expect(getMedia('pixabay:1', fakeEnv({ PIXABAY_API_KEY: undefined }))).rejects.toThrow('pixabay is not configured');
    await expect(getMedia('openverse:missing', fakeEnv())).rejects.toThrow('openverse:missing not found');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd free-media-mcp && npx vitest run tests/search.test.ts
```

Expected: FAIL, cannot resolve `../src/search`.

- [ ] **Step 3: Write `search.ts`**

`free-media-mcp/src/search.ts`:

```ts
import type { Env } from './env';
import { passesFilters } from './license';
import { openverse } from './providers/openverse';
import { pexels } from './providers/pexels';
import { pixabay } from './providers/pixabay';
import { PROVIDER_IDS, type MediaResult, type MediaType, type Orientation, type Provider, type ProviderId, type SearchQuery } from './types';

export interface SearchInput {
  query: string;
  media_type: MediaType;
  commercial_use_only: boolean;
  modification_allowed: boolean;
  orientation: Orientation;
  providers?: ProviderId[];
  limit: number;
}

export interface SearchOutput {
  results: MediaResult[];
  warnings: string[];
}

export function configuredProviders(env: Env): Provider[] {
  const out: Provider[] = [openverse];
  if (env.PEXELS_API_KEY) out.push(pexels);
  if (env.PIXABAY_API_KEY) out.push(pixabay);
  return out;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Same rule for every provider, because Pixabay cannot filter square images or any video orientation. */
export function matchesOrientation(w: number | null, h: number | null, o: Orientation): boolean {
  if (o === 'any' || w === null || h === null || h === 0) return true;
  const ratio = w / h;
  if (o === 'square') return Math.abs(ratio - 1) <= 0.05;
  return o === 'landscape' ? ratio > 1.05 : ratio < 0.95;
}

export function interleave<T>(lists: T[][], limit: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++)
    for (const l of lists) if (i < l.length && out.length < limit) out.push(l[i]!);
  return out;
}

export async function searchMedia(input: SearchInput, env: Env, providers = configuredProviders(env)): Promise<SearchOutput> {
  const warnings: string[] = [];
  const wanted = input.providers?.length ? input.providers : undefined;
  const active = providers.filter((p) => p.supports.includes(input.media_type) && (!wanted || wanted.includes(p.id)));
  for (const id of wanted ?? []) if (!active.some((p) => p.id === id)) warnings.push(`${id}: not configured or does not support ${input.media_type}`);
  if (active.length === 0) warnings.push('no providers available for this query');

  const q: SearchQuery = {
    query: input.query.trim(),
    media_type: input.media_type,
    orientation: input.orientation,
    limit: input.limit,
    commercial_use_only: input.commercial_use_only,
    modification_allowed: input.modification_allowed,
  };
  const settled = await Promise.allSettled(active.map((p) => p.search(q, env)));
  const lists = settled.map((s, i) => {
    if (s.status === 'rejected') {
      warnings.push(`${active[i]!.id}: ${errorMessage(s.reason)}`);
      return [];
    }
    return s.value.filter((r) => passesFilters(r.license, input) && matchesOrientation(r.width, r.height, input.orientation));
  });
  return { results: interleave(lists, input.limit), warnings };
}

export function parseId(id: string): { provider: ProviderId; nativeId: string } | null {
  const i = id.indexOf(':');
  if (i < 1) return null;
  const provider = id.slice(0, i);
  const nativeId = id.slice(i + 1);
  if (!nativeId || !(PROVIDER_IDS as readonly string[]).includes(provider)) return null;
  return { provider: provider as ProviderId, nativeId };
}

export async function getMedia(id: string, env: Env, providers = configuredProviders(env)): Promise<MediaResult> {
  const parsed = parseId(id);
  if (!parsed) throw new Error(`invalid id "${id}", expected "provider:native_id"`);
  const provider = providers.find((p) => p.id === parsed.provider);
  if (!provider) throw new Error(`${parsed.provider} is not configured`);
  const result = await provider.get(parsed.nativeId, env);
  if (!result) throw new Error(`${id} not found`);
  return result;
}
```

- [ ] **Step 4: Run the whole suite**

```bash
cd free-media-mcp && npm test && npm run typecheck
```

Expected: all PASS. The interleave expectation in "interleaves providers" assumes Openverse returns 3 items (one NC dropped), Pexels 2, Pixabay 1; if the order differs, check that `configuredProviders` order is openverse, pexels, pixabay.

- [ ] **Step 5: Commit**

```bash
git add free-media-mcp/src/search.ts free-media-mcp/tests/search.test.ts
git commit -m "feat(free-media-mcp): parallel search orchestration, interleave, license/orientation filters, getMedia

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: MCP server, tool descriptions, and the Worker entry

**Files:**
- Create: `free-media-mcp/src/server.ts`, `free-media-mcp/src/index.ts`
- Test: `free-media-mcp/tests/server.test.ts`

**Interfaces:**
- Consumes: `searchMedia`, `getMedia`, `errorMessage`, `attribution`, `PROVIDER_IDS`.
- Produces: `buildServer(env: Env): McpServer`; exported description constants `SEARCH_MEDIA_DESCRIPTION`, `GET_MEDIA_DESCRIPTION`, `GET_ATTRIBUTION_DESCRIPTION`; default Worker export `{ fetch(request: Request, env: Env): Promise<Response> }` serving `POST /mcp`.

- [ ] **Step 1: Write the failing tests**

`free-media-mcp/tests/server.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

```bash
cd free-media-mcp && npx vitest run tests/server.test.ts
```

Expected: FAIL, cannot resolve `../src/index` / `../src/server`.

- [ ] **Step 3: Write `server.ts`**

`free-media-mcp/src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { attribution } from './attribution';
import type { Env } from './env';
import { errorMessage, getMedia, searchMedia } from './search';
import { PROVIDER_IDS } from './types';

export const SEARCH_MEDIA_DESCRIPTION =
  'Search free, legally reusable stock images or videos from Openverse (Creative Commons and public-domain images), Pexels, and Pixabay in one call, ' +
  'and get back a compact list with a normalized license block per item. Use it when a design, web page, or post needs a photo or video and the user has no asset of their own. ' +
  'By default results under non-commercial (NC) or no-derivatives (ND) licenses are filtered out, because designs are usually commercial and crop or edit the media; ' +
  'set commercial_use_only or modification_allowed to false only when the user explicitly accepts that restriction. ' +
  'Before placing any result in a public design, page, or post, call get_attribution with the ids and include the credit line. ' +
  'Openverse aggregates third-party metadata and does not verify license accuracy: tell the user to confirm the license on the source page before commercial use. ' +
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
  const server = new McpServer({ name: 'opengallery-free-media', version: '0.1.0' });

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
```

- [ ] **Step 4: Write `index.ts`**

`free-media-mcp/src/index.ts`:

```ts
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
```

- [ ] **Step 5: Run the whole suite and typecheck**

```bash
cd free-media-mcp && npm test && npm run typecheck
```

Expected: all PASS. If `client.listTools()` hangs, check that the transport `fetch` passes `init` through unchanged (the client sends `Accept: application/json, text/event-stream`). The bare `ping` in the gate test skips `initialize` and the protocol-version header, so the handler may answer 400; the test only asserts it is not 401. Do not "fix" that 400.

- [ ] **Step 6: Run the Worker locally and hit it with curl**

```bash
cd free-media-mcp && cp .dev.vars.example .dev.vars && npx wrangler dev
```

In another shell (this is the `tools/list` probe from the SDK docs):

```bash
curl -s -X POST http://127.0.0.1:8787/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expected: a JSON (or SSE `data:`) body listing `search_media`, `get_media`, `get_attribution`. Stop `wrangler dev` (Ctrl-C).

- [ ] **Step 7: Commit**

```bash
git add free-media-mcp/src/server.ts free-media-mcp/src/index.ts free-media-mcp/tests/server.test.ts
git commit -m "feat(free-media-mcp): MCP server with three tools and gated Worker entry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: README, MCP Inspector check, real-provider verification, deploy

**Files:**
- Create: `free-media-mcp/README.md`

**Interfaces:** none (documentation and manual verification).

- [ ] **Step 1: Write the README**

`free-media-mcp/README.md`:

````markdown
# OpenGallery Free Media MCP

A remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that lets Claude search free, legally reusable images and videos from **Openverse**, **Pexels**, and **Pixabay** through one interface. Every result carries a normalized license block and a ready-made credit line, so Claude can drop media into Canva designs or web pages without guessing at rights.

Tools:

| Tool | Purpose |
| --- | --- |
| `search_media` | Query all configured providers in parallel; interleaved, license-filtered, compact results plus `warnings`. |
| `get_media` | One item by id with every rendition (image sizes, video resolutions with direct file URLs). |
| `get_attribution` | Paste-ready credit lines in `text`, `html`, or `markdown` (TASL for Creative Commons). |

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

**Pexels** (<https://www.pexels.com/api/documentation/#guidelines>, <https://www.pexels.com/license/>)
- Free for commercial use and modification; attribution not required by the license, but the API guidelines ask to credit photographers when possible and to show a prominent "Photos provided by Pexels" link. We set `attribution_required: true` and generate "Photo by X on Pexels" credits.
- Not allowed: selling unaltered copies, redistributing on stock or wallpaper platforms, implying endorsement by people or brands, use in trademarks, replicating Pexels' core functionality, working around rate limits.
- Rate limit 200 req/hour, 20,000/month per key. Identical searches are cached 1 hour.

**Pixabay** (<https://pixabay.com/api/docs/>, <https://pixabay.com/service/license-summary/>)
- Free for commercial use and modification; attribution not required, so `attribution_required: false`, but a credit line is still generated and the API terms require showing users where media comes from (`source_page_url` and the credit do that).
- API terms require caching responses for 24 hours (we cache Pixabay for 86,400 s), forbid permanent hotlinking of Pixabay URLs, and forbid systematic mass downloads. `full_url` is meant for a one-time import (for example Canva upload-from-URL), not for embedding directly in a page.
- `imageURL`/`fullHDURL` need "full API access"; standard keys get `largeImageURL` (1280 px).
- Rate limit 100 req/min per key. Search terms are capped at 100 characters.

**All providers**: every request sends `User-Agent: OpenGallery-FreeMediaMCP/0.1 (+https://github.com/pyamzi/OpenGallery)` and times out after 8 s. Nothing is downloaded or stored; the server only forwards metadata and URLs.

## Caching

Workers KV, not the Cache API: the Cache API is a no-op on `*.workers.dev` and is per-datacenter, while Pixabay requires 24 h caching regardless of where the Worker runs. Keys are SHA-256 hashes of the provider request URL (without API keys). TTLs: Openverse and Pexels 1 h, Pixabay 24 h, Openverse auth token until 5 minutes before expiry. On the KV free plan (1,000 writes/day) each uncached search writes one key per provider.

## Known limitations

- Rate limiting is per Cloudflare location and approximate, keyed by `cf-connecting-ip`; it is abuse mitigation, not accounting.
- Anonymous Openverse limits are per egress IP shared with other Workers; set the Openverse client credentials for anything beyond light use.
- Pixabay `square` and all Pixabay video orientation filtering happen after the fact by dimensions, so those provider slots may return fewer than requested.
- Pexels videos and Pixabay items have no title; Pexels photo titles are the `alt` text.
- `get_attribution` re-fetches each item (cached), so credits are only as fresh as the cache.
- No pagination, no color or size filters, no Unsplash (v1 scope).
````

Before saving the README, run `claude mcp add --help` and correct the header flag in the "Add it to claude.ai" section if it differs.

- [ ] **Step 2: Fill `.dev.vars` with a real Pexels key and start the Worker**

```bash
cd free-media-mcp && npm run dev
```

Expected: `wrangler dev` prints `Ready on http://127.0.0.1:8787`.

- [ ] **Step 3: Verify with MCP Inspector against real Openverse and Pexels**

```bash
cd free-media-mcp && npm run inspector
```

Connect with Streamable HTTP to `http://127.0.0.1:8787/mcp`. Verify, and record the outcome in the final report:

1. **List Tools** shows exactly `search_media`, `get_media`, `get_attribution`.
2. `search_media` `{"query":"golden hour wedding couple"}` returns results from both `openverse` and `pexels` interleaved, `warnings` empty, every `license.commercial_use` and `license.modification_allowed` true, no `cc-by-nc*` or `cc-by-nd` codes.
3. `search_media` `{"query":"golden hour wedding couple","commercial_use_only":false,"modification_allowed":false,"providers":["openverse"],"limit":20}` may now include NC/ND codes (proves the filter, not the provider, was hiding them).
4. `search_media` `{"query":"ocean waves","media_type":"video","limit":4}` returns only `pexels:video:…` ids (and `pixabay:video:…` if a Pixabay key is set) with `duration_seconds` set.
5. `get_media` with one returned id shows `renditions`.
6. `get_attribution` with two ids and `"format":"markdown"` returns two credit lines.
7. Run step 2 again: the response is immediate and `wrangler dev` logs show no outbound provider request (KV hit).

- [ ] **Step 4: Deploy and repeat the tools/list probe against the deployed URL**

```bash
cd free-media-mcp && npx wrangler kv namespace create MEDIA_CACHE
```

Paste the printed id into `wrangler.jsonc`, then:

```bash
cd free-media-mcp && npx wrangler secret put PEXELS_API_KEY && npm run deploy
```

```bash
curl -s -X POST https://opengallery-free-media-mcp.<account>.workers.dev/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expected: the three tools. Add the URL in claude.ai (**Customize > Connectors > Add custom connector**) and confirm the connector shows the three tools. If the deploy step cannot run in this session (no Cloudflare login), stop here and report that the deploy and connector steps were left for the owner.

- [ ] **Step 5: Commit**

```bash
git add free-media-mcp/README.md free-media-mcp/wrangler.jsonc
git commit -m "docs(free-media-mcp): README with setup, compliance notes, connector steps, example session

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** Docs read (research section). Stack: TS, Workers, Wrangler, official SDK v2 with Streamable HTTP via `createMcpHandler` (Task 8), Vitest with mocked fetch (Tasks 1–8), secrets via Wrangler (Task 1, README). Three tools with the exact inputs and defaults (Task 8). Parallel providers, per-provider warnings, Openverse image-only, interleaving, filters after normalization (Task 7). Compact output, no raw JSON (Task 8 `text()`). `get_media` with renditions (Tasks 4–6). `get_attribution` three formats with TASL (Task 2). `MediaResult` schema (Task 1). License rules table in one module with tests for every code, Pexels/Pixabay from their license pages, unknown never safe (Task 1). Openverse accuracy note in `search_media` description (Task 8). Caching 1 h (24 h Pixabay) with justification (Task 3, README). User-Agent (Task 3). Provider terms summarized (README). Auth choice with tradeoff (Task 8, README). Tool descriptions for Claude (Task 8). Required tests (Tasks 1, 7, 2). Deliverables: repo files (Task 1), README sections and example session (Task 9). Definition of done: `npm test` (every task), `wrangler dev` and Inspector and real search (Task 9). Pixabay confirmed and included (Task 6).

**Placeholder scan.** No TBD/TODO. Every code step contains the code; the README is written in full; the manual verification lists concrete calls and expected outcomes.

**Type consistency.** `SearchQuery` (Task 1) carries `commercial_use_only`/`modification_allowed`, used by Openverse (Task 4) and built in `searchMedia` (Task 7). `Provider.get(nativeId, env)` returns `MediaResult | null` in Tasks 4–6 and is consumed by `getMedia` (Task 7). `withAttribution` (Task 2) is called by all three providers. `errorMessage` is exported from `search.ts` (Task 7) and imported by `server.ts` (Task 8). `PROVIDER_IDS` lives in `types.ts` (Task 1) and is used by Tasks 7 and 8. `fakeEnv`'s `RATE_LIMITER` object structurally satisfies `RateLimit` (`limit({key}) → {success}`). Fixture `PX_VIDEO.video_files[2]` has `width: null`, which `mp4s()` filters out, so the video renditions test expects two entries. Task 7's interleave expectation `['openverse:…', 'pexels:2014422', 'pixabay:195893', 'openverse:ov3']` follows from provider order openverse, pexels, pixabay and the NC item being dropped.

**Review Focus.** Each of the five lines has a test in its owning task: (1) Task 7 `parseId`/`getMedia` errors, Task 5/6 numeric guards, Task 8 `get_media`/`get_attribution` bad-id tests; (2) Task 7 HTTP 429 and non-JSON tests; (3) Task 8 schema rejection test; (4) Task 7 providers-filter test; (5) Task 5 no-mp4 test, Task 6 empty-`large` fallback test.
