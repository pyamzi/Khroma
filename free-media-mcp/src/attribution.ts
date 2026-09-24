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
