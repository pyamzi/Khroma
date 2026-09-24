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
