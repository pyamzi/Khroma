import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { navigate } from '../router';
import type { Me } from '../App';
import type { PhotoItem, ProjectDetail, SelectionSummary, PickRow } from '../types';
import { Sheet } from '../components/Sheet';
import { Viewer } from '../components/Viewer';

type SelResp = { summary: SelectionSummary; picks: PickRow[] };
const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const applyPicks = (ph: PhotoItem[], picks: PickRow[]): PhotoItem[] => { const m = new Map(picks.map((k) => [k.photoId, k])); return ph.map((x) => { const k = m.get(x.id); return { ...x, pick: k ? { state: k.state, byEmail: k.byEmail, locked: k.locked } : null }; }); };

export function Cull({ id, me }: { id: string; me: Me }) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [sel, setSel] = useState<SelectionSummary | null>(null);
  const [filter, setFilter] = useState<'all' | 'picked'>('all');
  const [cols, setCols] = useState(3);
  const [open, setOpen] = useState<number | null>(null);
  const [sheet, setSheet] = useState<null | 'finish' | 'extras' | 'error'>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pinch = useRef<number | null>(null);

  const load = useCallback(async () => {
    const [p, ph, s] = await Promise.all([api<ProjectDetail>(`/api/projects/${id}`), api<PhotoItem[]>(`/api/projects/${id}/photos?stage=culling`), api<SelResp>(`/api/projects/${id}/selection`)]);
    setProject(p); setPhotos(ph); setSel(s.summary); selRef.current = s.summary;
  }, [id]);
  useEffect(() => { void load().catch(() => navigate('/')); }, [load]);
  useEffect(() => { const on = () => { if (document.visibilityState === 'visible') void load(); }; document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on); }, [load]);

  // Picks are serialized so rapid taps never race each other; each request carries the latest version.
  const selRef = useRef<SelectionSummary | null>(null); selRef.current = sel;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const togglePick = (photoId: string) => {
    const target = photos.find((p) => p.id === photoId); if (!target || target.pick?.locked || !sel) return;
    const picked = !target.pick;
    setPhotos((ps) => ps.map((p) => (p.id === photoId ? { ...p, pick: picked ? { state: 'pending', byEmail: me.subject, locked: false } : null } : p)));
    const send = async (retry: boolean): Promise<void> => {
      const version = selRef.current?.selectionVersion ?? 0;
      try {
        const r = await api<SelResp>(`/api/projects/${id}/picks`, { method: 'POST', body: JSON.stringify({ photoId, picked, selectionVersion: version }) });
        selRef.current = r.summary; setSel(r.summary); setPhotos((ps) => applyPicks(ps, r.picks));
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && retry) { await load(); return send(false); }
        if (e instanceof ApiError && (e.status === 409 || e.status === 422)) {
          if (e.status === 422) { setError(e.message === 'not_culling' ? 'Picking is closed for this project.' : 'That photo can’t be picked.'); setSheet('error'); }
          await load(); return;
        }
        throw e;
      }
    };
    queue.current = queue.current.then(() => send(true)).catch(() => undefined);
    return queue.current;
  };

  const finish = async () => {
    if (!sel) return; setBusy(true);
    try {
      await queue.current; // let queued heart taps land first, then use the version they produced
      await api(`/api/projects/${id}/finish`, { method: 'POST', body: JSON.stringify({ selectionVersion: selRef.current?.selectionVersion ?? sel.selectionVersion }) }); setSheet(null); navigate(`/p/${id}`);
    }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) { await load(); setSheet(null); return; }
      const msg: Record<string, string> = { pending_picks: 'Some picks are over your allowance. Remove them or ask for extras first.', no_picks: 'Pick at least one photo first.', unpaid_extras: 'Finish your extras purchase first.', needs_review: 'The studio is reviewing your account. Try again later.', deficit: 'The studio is reviewing your allowance. Try again later.' };
      setError(msg[(e as ApiError).message] ?? 'Could not finish right now.'); setSheet('error');
    } finally { setBusy(false); }
  };

  const requestExtras = async () => {
    if (!sel) return; setBusy(true);
    try { await api(`/api/projects/${id}/extras-request`, { method: 'POST', body: JSON.stringify({ count: sel.pending }) }); setError('Request sent. The studio will get back to you.'); setSheet('error'); }
    finally { setBusy(false); }
  };

  const dist = (e: React.TouchEvent) => Math.hypot(e.touches[0]!.clientX - e.touches[1]!.clientX, e.touches[0]!.clientY - e.touches[1]!.clientY);
  const onTouchStart = (e: React.TouchEvent) => { if (e.touches.length === 2) pinch.current = dist(e); };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length !== 2 || pinch.current === null) return;
    const d = dist(e);
    if (d > pinch.current * 1.3) { setCols((c) => Math.max(2, c - 1)); pinch.current = d; }
    if (d < pinch.current / 1.3) { setCols((c) => Math.min(5, c + 1)); pinch.current = d; }
  };

  if (!project || !sel) return null;
  const closed = project.state.production !== 'culling';
  const visible = filter === 'picked' ? photos.filter((p) => p.pick) : photos;
  const picked = sel.confirmed + sel.pending;
  const over = sel.pending > 0;
  const noPhotos = photos.length === 0 || photos.every((p) => !p.previewReady);

  return (
    <main className="pb-28" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={() => { pinch.current = null; }}>
      <header className="sticky top-0 z-10 flex items-center justify-between bg-white/90 px-2 py-2 backdrop-blur dark:bg-black/80">
        <button onClick={() => navigate(`/p/${id}`)} className="min-h-11 px-2 text-blue-600">‹ {project.title}</button>
        <div className="flex rounded-lg bg-neutral-200 p-0.5 text-sm dark:bg-neutral-800" role="tablist">
          {(['all', 'picked'] as const).map((f) => <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={`min-h-9 rounded-md px-3 ${filter === f ? 'bg-white shadow dark:bg-neutral-600' : ''}`}>{f === 'all' ? 'All' : 'Picked'}</button>)}
        </div>
      </header>
      {noPhotos ? <p className="p-6 text-center text-neutral-500">{photos.length === 0 ? 'No photos yet. The studio will let you know when they’re up.' : 'Previews aren’t ready yet. Check back soon.'}</p> : (
        <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {visible.map((p, i) => (
            <div key={p.id} data-testid="tile" data-picked={p.pick ? p.pick.state : 'no'} className="relative aspect-square bg-neutral-200 dark:bg-neutral-800">
              <button onClick={() => setOpen(photos.indexOf(p))} className="absolute inset-0" aria-label="Open photo">
                {p.previewReady && <img src={`/api/photos/${p.id}/preview?size=thumb&v=${p.v}`} loading={i < 30 ? 'eager' : 'lazy'} className="h-full w-full object-cover" alt="" />}
              </button>
              {p.kind === 'video' && <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-xs text-white">▶</span>}
              {p.comments.total > 0 && <span className="absolute left-1 bottom-1 rounded-full bg-black/60 px-1.5 text-xs text-white">{p.comments.total}</span>}
              <button onClick={() => void togglePick(p.id)} aria-label={p.pick ? 'Unpick' : 'Pick'} aria-pressed={!!p.pick} disabled={!!p.pick?.locked}
                className={`absolute right-1 bottom-1 flex h-9 w-9 items-center justify-center rounded-full text-lg ${p.pick ? (p.pick.state === 'pending' ? 'bg-amber-400 text-black' : 'bg-white text-red-500') : 'bg-black/40 text-white'} disabled:opacity-70`}>{p.pick ? '♥' : '♡'}</button>
            </div>))}
        </div>)}
      <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-neutral-200 bg-white/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur dark:border-neutral-800 dark:bg-black/90">
        {closed ? <p className="text-center text-neutral-500">{sel.submitted} pick{sel.submitted === 1 ? '' : 's'} sent · picking is closed</p> : over ? (
          <div className="flex items-center justify-between"><span>{sel.pending} extra photo{sel.pending > 1 ? 's' : ''} · {money(sel.pending * sel.extraPrice)}</span>
            <button onClick={() => setSheet('extras')} className="min-h-11 rounded-xl bg-black px-4 text-white dark:bg-white dark:text-black">Request</button></div>
        ) : (
          <div className="flex items-center justify-between"><span data-testid="count">{picked} of {sel.entitlement}</span>
            <button onClick={() => setSheet('finish')} disabled={picked === 0} className="min-h-11 rounded-xl bg-black px-4 text-white disabled:opacity-40 dark:bg-white dark:text-black">Finish</button></div>)}
      </footer>
      {open !== null && <Viewer photos={photos} index={open} me={me} commentsOn={project.comments.culling} onIndex={setOpen} onClose={() => setOpen(null)} onToggle={togglePick} onCommented={() => void load()} />}
      <Sheet open={sheet === 'finish'} onClose={() => setSheet(null)} title={`Send ${picked} pick${picked === 1 ? '' : 's'}?`}>
        <p className="text-neutral-600 dark:text-neutral-400">The studio will start editing these. You can still ask for extras later.</p>
        <button onClick={finish} disabled={busy} className="mt-4 min-h-11 w-full rounded-xl bg-black py-3 text-white disabled:opacity-40 dark:bg-white dark:text-black">Send picks</button>
      </Sheet>
      <Sheet open={sheet === 'extras'} onClose={() => setSheet(null)} title={`Ask for ${sel.pending} extra photo${sel.pending > 1 ? 's' : ''}?`}>
        <p className="text-neutral-600 dark:text-neutral-400">{money(sel.extraPrice)} each. The studio will confirm and send an invoice.</p>
        <button onClick={requestExtras} disabled={busy} className="mt-4 min-h-11 w-full rounded-xl bg-black py-3 text-white disabled:opacity-40 dark:bg-white dark:text-black">Send request</button>
      </Sheet>
      <Sheet open={sheet === 'error'} onClose={() => setSheet(null)}><p>{error}</p><button onClick={() => setSheet(null)} className="mt-4 min-h-11 w-full rounded-xl bg-neutral-200 py-3 dark:bg-neutral-800">OK</button></Sheet>
    </main>);
}
