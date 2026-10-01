import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Me } from '../App';
import type { PhotoItem, CommentRow } from '../types';

type Region = { x: number; y: number; w: number; h: number };
type Props = { photos: PhotoItem[]; index: number; me: Me; commentsOn: boolean; onIndex: (i: number) => void; onClose: () => void; onToggle: (id: string) => void; onCommented: () => void; onResolve?: (commentId: string, resolved: boolean) => Promise<void>;
  /** The heart's labels when it is on and off: the gallery's heart is a favorite, not a pick. */
  labels?: { on: string; off: string };
  onDownload?: (id: string) => void };
type Gesture = { x: number; y: number; drawing: boolean; timer?: ReturnType<typeof setTimeout> };

export function Viewer({ photos, index, me, commentsOn, onIndex, onClose, onToggle, onCommented, onResolve, labels = { on: 'Unpick', off: 'Pick' }, onDownload }: Props) {
  const photo = photos[index]!;
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [draft, setDraft] = useState<Region | null>(null);
  const [text, setText] = useState('');
  const [thread, setThread] = useState<CommentRow | null>(null);
  const [tsec, setTsec] = useState('');
  const img = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);

  useEffect(() => { setDraft(null); setThread(null); setText(''); if (commentsOn) void api<CommentRow[]>(`/api/photos/${photo.id}/comments`).then(setComments); else setComments([]); }, [photo.id, commentsOn]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'ArrowRight') onIndex(Math.min(photos.length - 1, index + 1)); if (e.key === 'ArrowLeft') onIndex(Math.max(0, index - 1)); if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on);
  }, [index, photos.length, onIndex, onClose]);

  const rel = (cx: number, cy: number): { x: number; y: number } | null => {
    const r = img.current?.getBoundingClientRect(); if (!r) return null;
    return { x: Math.min(1, Math.max(0, (cx - r.left) / r.width)), y: Math.min(1, Math.max(0, (cy - r.top) / r.height)) };
  };
  const canDraw = commentsOn && photo.kind === 'photo' && photo.previewReady;

  const start = (cx: number, cy: number, immediate: boolean) => {
    const p = rel(cx, cy); if (!p) return;
    const g: Gesture = { x: cx, y: cy, drawing: false }; gesture.current = g;
    if (!canDraw) return;
    if (immediate) { g.drawing = true; setDraft({ x: p.x, y: p.y, w: 0, h: 0 }); }
    else g.timer = setTimeout(() => { if (gesture.current === g) { g.drawing = true; setDraft({ x: p.x, y: p.y, w: 0, h: 0 }); } }, 500);
  };
  const move = (cx: number, cy: number) => {
    const g = gesture.current; if (!g) return;
    if (!g.drawing) { if (Math.hypot(cx - g.x, cy - g.y) > 10 && g.timer) clearTimeout(g.timer); return; }
    const a = rel(g.x, g.y); const b = rel(cx, cy); if (!a || !b) return;
    setDraft({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  };
  const end = (cx: number, cy: number) => {
    const g = gesture.current; gesture.current = null; if (!g) return; if (g.timer) clearTimeout(g.timer);
    if (g.drawing) { setDraft((d) => (d && (d.w < 0.02 || d.h < 0.02) ? null : d)); return; }
    const dx = cx - g.x, dy = cy - g.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) onIndex(dx < 0 ? Math.min(photos.length - 1, index + 1) : Math.max(0, index - 1));
    else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) onClose();
  };

  const post = async () => {
    const body: Record<string, unknown> = { text };
    if (photo.kind === 'photo' && draft) Object.assign(body, draft);
    if (photo.kind === 'video') body.t = Number(tsec) || 0;
    const c = await api<CommentRow>(`/api/photos/${photo.id}/comments`, { method: 'POST', body: JSON.stringify(body) });
    setComments((cs) => [...cs, c]); setDraft(null); setText(''); onCommented();
  };
  const showForm = (draft !== null && draft.w >= 0.02 && draft.h >= 0.02) || (commentsOn && photo.kind === 'video');

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-black text-white" role="dialog" aria-modal="true">
      <div className="flex items-center justify-between p-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button onClick={onClose} className="min-h-11 px-3" aria-label="Close">✕</button>
        <span className="text-sm text-neutral-400">{index + 1} / {photos.length}</span>
        <span className="w-11" />
      </div>
      <div className="relative flex flex-1 items-center justify-center overflow-hidden select-none touch-none"
        onTouchStart={(e) => start(e.touches[0]!.clientX, e.touches[0]!.clientY, false)}
        onTouchMove={(e) => move(e.touches[0]!.clientX, e.touches[0]!.clientY)}
        onTouchEnd={(e) => end(e.changedTouches[0]!.clientX, e.changedTouches[0]!.clientY)}
        onMouseDown={(e) => start(e.clientX, e.clientY, true)} onMouseMove={(e) => { if (e.buttons === 1) move(e.clientX, e.clientY); }} onMouseUp={(e) => end(e.clientX, e.clientY)}>
        <div ref={img} className="relative max-h-full max-w-full">
          {photo.kind === 'photo' && photo.previewReady
            ? <img src={`/api/photos/${photo.id}/preview?v=${photo.v}`} draggable={false} className="max-h-[calc(100vh-11rem)] max-w-full object-contain" alt="" />
            : <div className="flex h-64 w-64 items-center justify-center rounded bg-neutral-800 text-neutral-400">{photo.kind === 'video' ? 'Video' : 'Preview not ready'}</div>}
          {commentsOn && comments.map((c, i) => c.x !== null && c.y !== null && (
            <button key={c.id} onClick={(e) => { e.stopPropagation(); setThread(c); }} onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
              style={{ left: `${(c.x + (c.w ?? 0) / 2) * 100}%`, top: `${(c.y + (c.h ?? 0) / 2) * 100}%` }}
              className={`absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white text-xs font-semibold ${c.resolvedAt ? 'bg-neutral-500/60' : 'bg-blue-500'}`} aria-label={`Comment ${i + 1}`}>{i + 1}</button>))}
          {draft && <div className="pointer-events-none absolute border-2 border-yellow-300 bg-yellow-300/10" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }} />}
        </div>
      </div>
      <div className="flex items-center justify-between p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <span className="text-sm text-neutral-400">{commentsOn && comments.length > 0 ? `${comments.length} comment${comments.length > 1 ? 's' : ''}` : ''}{canDraw && !draft ? (comments.length ? ' · ' : '') + 'hold to draw' : ''}</span>
        <div className="flex items-center gap-2">
          {onDownload && <button onClick={() => onDownload(photo.id)} className="min-h-12 rounded-full bg-white/20 px-4">Download</button>}
          <button onClick={() => onToggle(photo.id)} disabled={!!photo.pick?.locked} aria-pressed={!!photo.pick} aria-label={photo.pick ? labels.on : labels.off}
            className={`flex h-12 w-12 items-center justify-center rounded-full text-2xl ${photo.pick ? (photo.pick.state === 'pending' ? 'bg-amber-400 text-black' : 'bg-white text-red-500') : 'bg-white/20'} disabled:opacity-60`}>{photo.pick ? '♥' : '♡'}</button>
        </div>
      </div>
      {showForm && (
        <form onSubmit={(e) => { e.preventDefault(); void post(); }} className="flex gap-2 bg-neutral-900 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {photo.kind === 'video' && <input inputMode="decimal" value={tsec} onChange={(e) => setTsec(e.target.value)} placeholder="seconds" className="w-24 rounded-lg bg-neutral-800 px-3 py-2" aria-label="Timestamp in seconds" />}
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note" className="min-h-11 flex-1 rounded-lg bg-neutral-800 px-3" data-testid="comment-input" />
          <button disabled={!text.trim()} className="min-h-11 rounded-lg bg-white px-4 text-black disabled:opacity-40">Post</button>
          {draft && <button type="button" onClick={() => setDraft(null)} className="min-h-11 px-2 text-neutral-400">Cancel</button>}
        </form>)}
      {thread && (
        <div className="absolute inset-x-3 bottom-24 rounded-xl bg-neutral-900 p-4 shadow-xl" role="dialog" aria-label="Comment">
          <div className="flex items-start justify-between"><p className="text-sm text-neutral-400">{thread.author === me.subject ? 'You' : thread.author}{thread.resolvedAt ? ' · resolved' : ''}</p><button onClick={() => setThread(null)} className="min-h-8 px-2" aria-label="Close thread">✕</button></div>
          <p className="mt-1">{thread.text}</p>
          {onResolve && <button onClick={() => { void onResolve(thread.id, !thread.resolvedAt).then(() => { setComments((cs) => cs.map((c) => (c.id === thread.id ? { ...c, resolvedAt: thread.resolvedAt ? null : new Date().toISOString() } : c))); setThread(null); }); }} className="mt-3 min-h-9 rounded-lg bg-white px-3 text-sm text-black">{thread.resolvedAt ? 'Unresolve' : 'Resolve'}</button>}
        </div>)}
    </div>);
}
