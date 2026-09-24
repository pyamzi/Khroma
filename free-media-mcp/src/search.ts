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
