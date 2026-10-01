import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ApiError } from '../api';
import { Shell } from './Shell';
import { Button, Empty } from './ui';
import { completeUpload, deleteLibraryPhoto, libraryPage, libraryStatus, putFile, startUpload, type LibraryItem } from './api';

const MAX_BYTES = 52_428_800;
const EXT = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];
const PAGE = Number(new URLSearchParams(window.location.search).get('pageSize')) || 60; // ?pageSize= is a test hook
const SERVER_MAX = 200; const STATUS_MAX = 100; const CONCURRENCY = 3;
/** The server's refusal codes (too_large 413, unsupported 415), worded once for the browser pre-check and the server's reply alike. */
const REFUSAL: Record<string, string> = { too_large: 'over the 50 MB limit', unsupported: 'not a supported photo type' };
const refusal = (f: File) => EXT.some((e) => f.name.toLowerCase().endsWith(e)) ? (f.size > MAX_BYTES ? REFUSAL.too_large : null) : REFUSAL.unsupported;
type Pending = { key: number; name: string; pct: number };

export function Library() {
  const [items, setItems] = useState<LibraryItem[]>([]); const [total, setTotal] = useState<number | null>(null); const [next, setNext] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]); const [notices, setNotices] = useState<string[]>([]); const [over, setOver] = useState(false); const [watching, setWatching] = useState(0);
  const input = useRef<HTMLInputElement>(null); const queue = useRef<File[]>([]); const running = useRef(0); const keys = useRef(0);
  const mine = useRef(new Map<string, string>()); // photo id -> name, uploaded in this tab and not yet seen ready
  const size = useRef(PAGE); const seq = useRef(0);
  const notify = (m: string) => setNotices((n) => [...n, m]);

  /** Refetches everything loaded so far, for display (so polling never drops "Load more" pages; ponytail: capped at the server's 200). */
  const load = useCallback(async () => {
    const mark = ++seq.current; const p = await libraryPage(Math.min(SERVER_MAX, size.current));
    if (mark !== seq.current) return; // a newer response is in flight
    setItems(p.items); setTotal(p.total); setNext(p.nextCursor);
  }, []);
  /** Exact states of this tab's uploads, whether or not they are in the loaded window. Only `failed` is a failure; an id the server no longer knows was deleted or swept. */
  const check = useCallback(async () => {
    const ids = [...mine.current.keys()];
    for (let i = 0; i < ids.length; i += STATUS_MAX) {
      const got = new Map((await libraryStatus(ids.slice(i, i + STATUS_MAX))).map((r) => [r.id, r.status]));
      for (const id of ids.slice(i, i + STATUS_MAX)) {
        const st = got.get(id);
        if (st === 'failed') notify(`${mine.current.get(id)}: Couldn't process this file`);
        if (st !== 'processing' && st !== 'uploading') mine.current.delete(id);
      }
    }
    setWatching(mine.current.size);
  }, []);
  const more = async () => { const p = await libraryPage(PAGE, next!); size.current += p.items.length; setItems((x) => [...x, ...p.items.filter((n) => !x.some((o) => o.id === n.id))]); setTotal(p.total); setNext(p.nextCursor); };

  useEffect(() => { void load().catch(() => setTotal(0)); }, [load]);
  const busy = pending.length > 0 || watching > 0 || items.some((i) => i.status === 'processing');
  useEffect(() => { if (!busy) return; const t = setInterval(() => void Promise.all([load(), check()]).catch(() => undefined), 2000); return () => clearInterval(t); }, [busy, load, check]);

  const uploadOne = async (file: File, key: number) => {
    const set = (pct: number) => setPending((p) => p.map((x) => x.key === key ? { ...x, pct } : x));
    let id: string | undefined;
    try {
      const up = await startUpload(file.name, file.size); id = up.photoId;
      await putFile(up.uploadUrl, file, up.contentType, set);
      await completeUpload(up.photoId); mine.current.set(up.photoId, file.name); setWatching(mine.current.size);
    } catch (e) {
      if (id) await deleteLibraryPhoto(id).catch(() => undefined); // best effort: no ghost row until the hourly sweep
      notify(`${file.name}: ${e instanceof ApiError && REFUSAL[e.message] ? REFUSAL[e.message] : "Couldn't upload this file"}`);
    }
    await load().catch(() => undefined); // the photo is in the list before its placeholder goes
    setPending((p) => p.filter((x) => x.key !== key));
  };
  const pump = () => {
    while (running.current < CONCURRENCY && queue.current.length) {
      const f = queue.current.shift()!; const key = ++keys.current; running.current++;
      setPending((p) => [...p, { key, name: f.name, pct: 0 }]);
      void uploadOne(f, key).finally(() => { running.current--; pump(); });
    }
  };
  const add = (files: File[]) => {
    for (const f of files) { const why = refusal(f); if (why) notify(`${f.name}: ${why}`); else queue.current.push(f); }
    pump();
  };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); add([...e.dataTransfer.files]); };

  return (
    <Shell section="/admin/library" title="Library">
      <p className="mb-3 text-sm text-neutral-500">{total === null ? '' : total === 1 ? '1 photo' : `${total} photos`}</p>
      <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
        className={`mb-4 flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed p-6 text-center ${over ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-neutral-300 dark:border-neutral-700'}`}>
        <p className="text-neutral-600 dark:text-neutral-400">Drop photos here (JPEG, PNG, WebP or HEIC, up to 50 MB each)</p>
        <Button kind="secondary" onClick={() => input.current?.click()}>Choose files</Button>
        <input ref={input} data-testid="library-input" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.heic" hidden tabIndex={-1}
          onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>
      {notices.map((n, i) => (
        <div key={i} role="alert" className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-red-100 px-4 py-2 text-red-800">
          <span>{n}</span><button className="min-h-11 min-w-11 text-xl" aria-label="Dismiss" onClick={() => setNotices((x) => x.filter((_, j) => j !== i))}>×</button>
        </div>))}
      {total === 0 && pending.length === 0 ? <Empty>No photos yet. Drop some above.</Empty> : (
        <div className="grid grid-cols-3 gap-1 md:grid-cols-6">
          {pending.map((p) => (
            <div key={p.key} data-testid="library-pending" className="relative flex aspect-square flex-col items-center justify-center gap-1 bg-neutral-200 p-1 text-center text-xs dark:bg-neutral-800">
              <span className="w-full truncate">{p.name}</span><progress className="w-4/5" value={p.pct} max={100} aria-label={`Uploading ${p.name}`} />
            </div>))}
          {items.map((x) => (
            <div key={x.id} data-testid="library-tile" className="relative aspect-square bg-neutral-200 dark:bg-neutral-800">
              {x.status === 'ready'
                ? <img src={`/api/photos/${x.id}/preview?size=thumb&v=${x.v}`} loading="lazy" className="h-full w-full object-cover" alt="" />
                : <span className="flex h-full items-center justify-center text-sm text-neutral-500">{x.status === 'processing' ? 'Processing…' : 'Uploading…'}</span>}
              {x.projectTitle && <span className="absolute inset-x-1 bottom-1 truncate rounded bg-black/60 px-1 text-xs text-white">{x.projectTitle}</span>}
            </div>))}
        </div>)}
      {next && <div className="mt-4 text-center"><Button kind="secondary" onClick={() => void more()}>Load more</Button></div>}
    </Shell>);
}
