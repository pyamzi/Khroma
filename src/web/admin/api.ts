import { api } from '../api';
export type Item = { projectId: string; title: string; client: string; reason: string; count?: number; since: string };
export type Dashboard = { waitingOnYou: Item[]; waitingOnClient: Item[]; money: unknown[]; upcoming: { projectId: string; title: string; client: string; date: string }[] };
export type Studio = { studioName: string; timezone: string; currency: string; defaultIncluded: number; defaultExtraPrice: number; reviewUrl: string };
export type Settings = { studio: Studio; limits: { attachmentBytes: number; mediaBytes: number } };
export type User = { id: string; email: string; name: string; role: 'owner' | 'member'; notifyDownloads: 'off' | 'digest' | 'each'; createdAt: string };
export type Job = { id: string; kind: string; state: string; attempts: number; lastError: string | null; createdAt: string; nextAt: number };
export type ClientRow = { id: string; name: string; emails: string[]; projects: number };
export type ProjectSummary = { id: string; clientId: string; title: string; date: string | null; state: { booking: string; production: string; archivedAt: string | null } };
export type ClientDetail = ClientRow & { phone?: string; notes?: string; projects: ProjectSummary[] };
export type EventRow = { id: number; projectId: string | null; actor: string; type: string; payload: Record<string, unknown>; at: string };
export type Insights = { views: number; uniqueVisitors: number; byDay: { day: string; views: number; picks: number; comments: number }[]; visitors: { actor: string; views: number; lastSeen: string }[] };
export type PluginToken = { id: string; name: string; scope: 'read' | 'read+write'; projectId: string | null; createdBy: string; createdAt: string; expiresAt: string };

export const PRODUCTION: Record<string, string> = { not_started: 'Waiting for photos', shot: 'Shot', culling: 'Culling', editing: 'Editing', delivered: 'Delivered' };
export const REASON: Record<string, string> = { culling_finished: 'Picks are in', unresolved_comments: 'Comments to answer', drafts: 'Drafts to publish', preview_failed: 'Previews failed', review_jobs: 'Jobs need review', culling_idle: 'Client has gone quiet' };
export const bytes = (n: number | null) => n === null ? '' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
export const ago = (iso: string) => { const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)}m`; if (s < 86400) return `${Math.round(s / 3600)}h`; return `${Math.round(s / 86400)}d`; };

export const publishFinals = (projectId: string, photoIds: string[], expectedVersion: number) =>
  api<{ published: number }>(`/api/projects/${projectId}/publish`, { method: 'POST', body: JSON.stringify({ photoIds, expectedVersion }) });

export type LibraryItem = { id: string; status: 'uploading' | 'processing' | 'ready'; width: number | null; height: number | null; createdAt: string; projectId: string | null; projectTitle: string | null; v: string };
export type LibraryPage = { total: number; items: LibraryItem[]; nextCursor: string | null };
export const libraryPage = (limit: number, cursor?: string) => api<LibraryPage>(`/api/library?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
export const startUpload = (name: string, size: number) => api<{ photoId: string; uploadUrl: string; contentType: string }>('/api/library/uploads', { method: 'POST', body: JSON.stringify({ name, size }) });
export const completeUpload = (photoId: string) => api<{ ok: true }>(`/api/library/uploads/${photoId}/complete`, { method: 'POST', body: '{}' });
/** XHR, not fetch, for upload progress. R2 signs the content type, so it must be exactly the one startUpload returned; no other headers (cross-origin, no cookies). */
export const putFile = (url: string, file: File, contentType: string, onProgress: (pct: number) => void) => new Promise<void>((resolve, reject) => {
  const x = new XMLHttpRequest(); x.open('PUT', url); x.setRequestHeader('Content-Type', contentType);
  x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
  x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`upload ${x.status}`)));
  x.onerror = () => reject(new Error('upload failed')); x.send(file);
});
