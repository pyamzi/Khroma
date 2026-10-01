import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { navigate } from '../router';
import type { Me } from '../App';
import type { PhotoItem, ProjectDetail } from '../types';
import { Sheet } from '../components/Sheet';
import { Viewer } from '../components/Viewer';

type Favs = { counts: Record<string, number>; mine: string[] };
type Dl = { url?: string; preparing?: true };
const WHY: Record<string, string> = {
  unavailable: 'This gallery is no longer available.', no_finals: 'There are no photos to download yet.', disabled: 'Downloads are turned off for this gallery.',
  review: 'Downloads open once your photographer has reviewed your account.', unpaid: 'Downloads open once your balance is paid.',
};
const POLL_MS = 3000; const POLL_TRIES = 100; // about 5 minutes

/** The delivered finals: hearts, a Favorites filter, single downloads from the viewer and a ZIP of everything. */
export function Gallery({ id, me }: { id: string; me: Me }) {
  const [p, setP] = useState<ProjectDetail | null>(null);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [onlyFavs, setOnlyFavs] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [sheet, setSheet] = useState(false);
  const [zip, setZip] = useState<{ state: 'idle' | 'preparing' | 'ready' | 'error'; url?: string; msg?: string }>({ state: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const loadFavs = () => api<Favs>(`/api/projects/${id}/favorites`).then((f) => setMine(new Set(f.mine)));
  useEffect(() => {
    void Promise.all([api<ProjectDetail>(`/api/projects/${id}`), api<PhotoItem[]>(`/api/projects/${id}/photos?stage=final`), loadFavs()])
      .then(([d, ph]) => { setP(d); setPhotos(ph); }).catch(() => navigate('/'));
    return () => clearTimeout(timer.current);
  }, [id]);

  // the Viewer's heart reads `pick`; here it shows the viewer's own favorite
  const shown = useMemo(() => photos.filter((ph) => !onlyFavs || mine.has(ph.id))
    .map((ph) => ({ ...ph, pick: mine.has(ph.id) ? { state: 'confirmed' as const, byEmail: me.subject, locked: false } : null })), [photos, mine, onlyFavs, me.subject]);

  const toggle = (photoId: string) => {
    const favorite = !mine.has(photoId);
    setMine((m) => { const n = new Set(m); if (favorite) n.add(photoId); else n.delete(photoId); return n; });
    void api(`/api/photos/${photoId}/favorite`, { method: 'POST', body: JSON.stringify({ favorite }) }).catch(() => loadFavs());
  };
  const request = (photoId?: string) => api<Dl>(`/api/projects/${id}/download`, { method: 'POST', body: JSON.stringify(photoId ? { photoId } : {}) });
  const why = (e: unknown) => (e instanceof ApiError && WHY[e.message]) || 'The download failed. Try again.';
  const downloadOne = async (photoId: string) => {
    try { const r = await request(photoId); if (r.url) window.location.href = r.url; }
    catch (e) { setZip({ state: 'error', msg: why(e) }); setSheet(true); }
  };
  const downloadAll = async (tries = 0): Promise<void> => {
    clearTimeout(timer.current);
    try {
      const r = await request();
      if (r.url) { setZip({ state: 'ready', url: r.url }); window.location.href = r.url; return; }
      if (tries >= POLL_TRIES) { setZip({ state: 'error', msg: 'Still preparing, try again shortly.' }); return; }
      setZip({ state: 'preparing' }); timer.current = setTimeout(() => void downloadAll(tries + 1), POLL_MS);
    } catch (e) { setZip({ state: 'error', msg: why(e) }); }
  };

  if (!p) return null;
  return (
    <main className="mx-auto max-w-5xl p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <button onClick={() => navigate(`/p/${id}`)} className="min-h-11 text-blue-600">‹ {p.title}</button>
      <div className="mt-1 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Your gallery</h1>
        <button onClick={() => setSheet(true)} className="min-h-11 rounded-xl bg-black px-4 font-medium text-white dark:bg-white dark:text-black">Download</button>
      </div>
      <div role="tablist" aria-label="Show" className="mt-4 flex gap-2">
        {([[false, `All · ${photos.length}`], [true, `Favorites · ${mine.size}`]] as const).map(([f, label]) => (
          <button key={label} role="tab" aria-selected={onlyFavs === f} onClick={() => setOnlyFavs(f)}
            className={`min-h-11 rounded-full px-4 ${onlyFavs === f ? 'bg-black text-white dark:bg-white dark:text-black' : 'bg-neutral-100 dark:bg-neutral-900'}`}>{label}</button>))}
      </div>
      {shown.length === 0
        ? <p className="mt-12 text-center text-neutral-500">{onlyFavs ? 'Tap ♡ on a photo to keep it here.' : 'Your photos are on the way.'}</p>
        : <ul className="mt-4 grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((ph, i) => (
            <li key={ph.id} data-testid="gallery-tile" className="relative aspect-square overflow-hidden bg-neutral-200 dark:bg-neutral-800">
              <button onClick={() => setOpen(i)} aria-label="Open photo" className="block h-full w-full">
                {ph.previewReady && <img src={`/api/photos/${ph.id}/preview?size=medium&v=${ph.v}`} loading="lazy" alt="" className="h-full w-full object-cover" />}
              </button>
              <button onClick={() => toggle(ph.id)} aria-pressed={!!ph.pick} aria-label={ph.pick ? 'Unfavorite' : 'Favorite'}
                className="absolute right-1 bottom-1 flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-xl text-white">{ph.pick ? <span className="text-red-500">♥</span> : '♡'}</button>
            </li>))}
        </ul>}
      {open !== null && open < shown.length && (
        <Viewer photos={shown} index={open} me={me} commentsOn={false} onIndex={setOpen} onClose={() => setOpen(null)} onToggle={toggle} onCommented={() => {}}
          labels={{ on: 'Unfavorite', off: 'Favorite' }} onDownload={(photoId) => void downloadOne(photoId)} />)}
      <Sheet open={sheet} onClose={() => setSheet(false)} title="Download">
        <p className="text-sm text-neutral-500">Single photos save to Photos; the ZIP goes to Files.</p>
        <button onClick={() => void downloadAll()} disabled={zip.state === 'preparing'}
          className="mt-4 min-h-11 w-full rounded-xl bg-black py-3 font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black">
          {zip.state === 'preparing' ? 'Preparing your ZIP…' : `Download all (${photos.length})`}</button>
        {zip.state === 'ready' && <a href={zip.url} className="mt-3 flex min-h-11 items-center justify-center text-blue-600">Save ZIP</a>}
        {zip.msg && <p role="status" className="mt-3 text-sm">{zip.msg}</p>}
        <p className="mt-3 text-sm text-neutral-500">For one photo, open it and tap Download.</p>
      </Sheet>
    </main>);
}
