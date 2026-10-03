import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { navigate } from '../router';
import { Shell } from './Shell';
import { Button, Empty, Input, Pill, Row, Segmented, Toast } from './ui';
import { Sheet } from '../components/Sheet';
import { bytes, ago, PRODUCTION, type Entry, type ProjectSummary, type ClientRow } from './api';

type TrashItem = { trashRel: string; original: string; trashedAt: string; size: number | null };
const icon = (e: Entry) => e.kind === 'client' ? '☺' : e.kind === 'project' ? '▣' : e.kind === 'dir' ? '▸' : e.media === 'photo' ? '▨' : e.media === 'video' ? '▶' : e.media === 'document' ? '▤' : e.media === 'audio' ? '♪' : '·';
const tone = (s: string) => s === 'culling' ? 'amber' : s === 'editing' ? 'blue' : s === 'delivered' ? 'green' : 'neutral';
const COLS = ['not_started', 'shot', 'culling', 'editing', 'delivered'] as const;
const GUARD: Record<string, string> = { culling: 'Culling starts by itself when RAWs land in the raw folder.', editing: 'Editing starts when the client finishes picking.', delivered: 'Delivered happens when you publish finals (milestone 5).', not_started: 'A project cannot go back to not started.' };

export function Files() {
  const [view, setView] = useState<'list' | 'board'>('list');
  const [path, setPath] = useState(() => new URLSearchParams(window.location.search).get('path') ?? '');
  const [entries, setEntries] = useState<Entry[]>([]); const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [q, setQ] = useState(''); const [toast, setToast] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ rel: string; name: string } | null>(null);
  const [moving, setMoving] = useState<{ rel: string; dir: string; dirs: Entry[] } | null>(null);
  const [confirmMove, setConfirmMove] = useState<{ from: string; to: string } | null>(null);
  const [menu, setMenu] = useState<Entry | null>(null);
  const [projectsAll, setProjectsAll] = useState<(ProjectSummary & { client?: string })[]>([]);
  const [board, setBoard] = useState<{ filter: 'mine' | 'everyone' | 'archived'; drag: string | null }>({ filter: 'everyone', drag: null });
  const fileInput = useRef<HTMLInputElement>(null);
  const inTrash = path === '.trash';

  const load = useCallback(async () => {
    if (inTrash) { setTrashItems(await api<TrashItem[]>('/api/files/trash')); return; }
    const r = await api<{ rel: string; entries: Entry[] }>(`/api/files?path=${encodeURIComponent(path)}`); setEntries(r.entries);
  }, [path, inTrash]);
  useEffect(() => { void load().catch((e) => { setToast(e instanceof ApiError ? e.message : 'Could not load'); if (path) go(''); }); }, [load]);
  useEffect(() => { if (view === 'board') void Promise.all([api<ProjectSummary[]>('/api/projects'), api<ClientRow[]>('/api/clients')]).then(([ps, cs]) => { const byPath = new Map(cs.map((c) => [c.folderPath, c.name])); setProjectsAll(ps.map((p) => ({ ...p, client: byPath.get(p.folderPath.split('/').slice(0, 2).join('/')) }))); }); }, [view]);
  const go = (p: string) => { setPath(p); window.history.replaceState({}, '', `/admin/files${p ? `?path=${encodeURIComponent(p)}` : ''}`); };
  const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) setToast(ok); await load(); return true; } catch (e) { setToast(e instanceof ApiError ? errText(e.message) : 'Something went wrong'); return false; } };
  const errText = (code: string) => ({ reserved: 'That location is managed by OpenGallery.', exists: 'Something with that name already exists.', not_found: 'Not found.', too_large: 'That file is over the size limit.', unsupported: 'That file type is not allowed.', needs_confirm: 'Moving between clients needs confirmation.' }[code] ?? code);

  const open = (e: Entry) => e.kind === 'project' && e.id ? navigate(`/admin/projects/${e.id}`) : e.kind === 'client' && e.id ? navigate(`/admin/clients/${e.id}`) : e.kind === 'file' ? window.open(`/api/files/download?path=${encodeURIComponent(e.rel)}`, '_blank') : go(e.rel);
  const mkdir = async () => { const name = prompt('Folder name'); if (!name) return; await run(() => api('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ path: path ? `${path}/${name}` : name }) }), 'Folder created'); };
  const upload = async (files: FileList | null) => { if (!files) return; for (const f of Array.from(files)) { const fd = new FormData(); fd.append('file', f); await run(() => fetch(`/api/files/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: fd, headers: { 'x-requested-with': 'fetch' } }).then(async (r) => { if (!r.ok) throw new ApiError(r.status, (await r.json()).error); })); } setToast('Uploaded'); };
  const move = async (fromRel: string, toRel: string, confirmed = false) => {
    try { await api('/api/files/move', { method: 'POST', body: JSON.stringify({ from: fromRel, to: toRel, confirm: confirmed }) }); setConfirmMove(null); setMoving(null); setRenaming(null); await load(); }
    catch (e) { if (e instanceof ApiError && e.message === 'needs_confirm') setConfirmMove({ from: fromRel, to: toRel }); else setToast(e instanceof ApiError ? errText(e.message) : 'Move failed'); }
  };
  const rename = async () => { if (!renaming) return; const parent = renaming.rel.split('/').slice(0, -1).join('/'); await move(renaming.rel, parent ? `${parent}/${renaming.name}` : renaming.name); };
  const openMove = async (rel: string) => { const dirs = (await api<{ entries: Entry[] }>('/api/files?path=')).entries.filter((e) => e.kind !== 'file'); setMoving({ rel, dir: '', dirs }); };
  const moveBrowse = async (dir: string) => { const dirs = (await api<{ entries: Entry[] }>(`/api/files?path=${encodeURIComponent(dir)}`)).entries.filter((e) => e.kind !== 'file'); setMoving((m) => m && { ...m, dir, dirs }); };
  const trashIt = (rel: string) => run(() => api('/api/files/trash', { method: 'POST', body: JSON.stringify({ path: rel }) }), 'Moved to Trash');
  const restore = (trashRel: string) => run(() => api('/api/files/restore', { method: 'POST', body: JSON.stringify({ trashRel }) }), 'Restored');
  const shareable = (e: Entry) => e.kind === 'file' && /^Clients\/[^/]+\/[^/]+\//.test(e.rel) && !/^Clients\/[^/]+\/[^/]+\/(raw|finals)\//.test(e.rel);
  const projectOf = (rel: string) => { const m = rel.match(/^(Clients\/[^/]+\/[^/]+)\//); return m ? entries.find((e) => e.rel === m[1]) : undefined; };

  const crumbs = path.split('/').filter(Boolean);
  const visible = entries.filter((e) => !q || e.name.toLowerCase().includes(q.toLowerCase()));
  const onDrop = (target: Entry) => (ev: React.DragEvent) => { ev.preventDefault(); const from = ev.dataTransfer.getData('text/rel'); if (from && target.kind !== 'file' && from !== target.rel) void move(from, `${target.rel}/${from.split('/').pop()}`); };

  const actions = <>
    <Segmented value={view} options={[['list', 'List'], ['board', 'Board']]} onChange={setView} />
    {view === 'list' && !inTrash && <><Button kind="secondary" onClick={mkdir}>New folder</Button><Button onClick={() => fileInput.current?.click()}>Upload</Button><input ref={fileInput} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} /></>}
  </>;

  if (view === 'board') {
    const cards = projectsAll.filter((p) => board.filter === 'archived' ? p.state.archivedAt : !p.state.archivedAt).filter((p) => !q || p.title.toLowerCase().includes(q.toLowerCase()) || (p.client ?? '').toLowerCase().includes(q.toLowerCase()));
    const dropCol = (col: string) => async (ev: React.DragEvent) => { ev.preventDefault(); const id = board.drag; setBoard((b) => ({ ...b, drag: null })); const p = projectsAll.find((x) => x.id === id); if (!p || p.state.production === col) return;
      if (p.state.production === 'not_started' && col === 'shot') { try { await api(`/api/projects/${id}/shot`, { method: 'POST' }); setView('list'); setView('board'); } catch { setToast('Could not mark as shot'); } } else setToast(GUARD[col] ?? 'That move is not available.'); };
    return (
      <Shell section="/admin/files" title="Board" actions={actions}>
        <div className="mb-3 flex flex-wrap items-center gap-2"><Segmented value={board.filter} options={[['everyone', 'Everyone'], ['mine', 'Mine'], ['archived', 'Archived']]} onChange={(f) => setBoard((b) => ({ ...b, filter: f }))} /><Input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="!mt-0 w-56" /></div>
        <div className="grid gap-3 md:grid-cols-5">
          {COLS.map((col) => (
            <div key={col} onDragOver={(e) => e.preventDefault()} onDrop={dropCol(col)} className="min-h-40 rounded-2xl bg-neutral-200/60 p-2 dark:bg-neutral-900">
              <p className="mb-2 px-1 text-sm font-medium text-neutral-600 dark:text-neutral-400">{PRODUCTION[col]}</p>
              {cards.filter((p) => p.state.production === col).map((p) => (
                <div key={p.id} draggable onDragStart={() => setBoard((b) => ({ ...b, drag: p.id }))} onClick={() => navigate(`/admin/projects/${p.id}`)} className="mb-2 cursor-pointer rounded-xl bg-white p-3 shadow-sm dark:bg-neutral-800" data-testid="card">
                  <p className="font-medium">{p.title}</p><p className="text-sm text-neutral-500">{p.client ?? ''}{p.date ? ` · ${p.date}` : ''}</p>
                  {!p.available && <Pill tone="red">unavailable</Pill>}{p.transferPending && <Pill tone="amber">transfer pending</Pill>}
                </div>))}
            </div>))}
        </div>
        <Toast msg={toast} onDone={() => setToast(null)} />
      </Shell>);
  }

  return (
    <Shell section="/admin/files" title="Files" actions={actions}>
      <nav className="mb-2 flex flex-wrap items-center gap-1 text-sm" aria-label="Breadcrumb">
        <button onClick={() => go('')} className="min-h-9 text-blue-600">Photos</button>
        {inTrash ? <><span>/</span><span>Trash</span></> : crumbs.map((c, i) => <span key={i} className="flex items-center gap-1"><span>/</span><button onClick={() => go(crumbs.slice(0, i + 1).join('/'))} className="min-h-9 text-blue-600">{c}</button></span>)}
        <span className="ml-auto flex items-center gap-2"><Input placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="!mt-0 w-40" />{!inTrash && <Button kind="plain" onClick={() => go('.trash')}>Trash</Button>}</span>
      </nav>
      <div className="rounded-2xl bg-white px-4 shadow-sm dark:bg-neutral-900">
        {inTrash ? (trashItems.length === 0 ? <Empty>Trash is empty. Items are removed for good after 30 days.</Empty> : trashItems.map((t) => (
          <Row key={t.trashRel}><span className="w-6 text-center text-neutral-400">⌫</span><div className="min-w-0 flex-1"><p className="truncate">{t.original}</p><p className="text-sm text-neutral-500">trashed {ago(t.trashedAt)} ago{t.size !== null ? ` · ${bytes(t.size)}` : ''}</p></div><Button kind="secondary" onClick={() => void restore(t.trashRel)}>Restore</Button></Row>)))
        : visible.length === 0 ? <Empty>{q ? 'Nothing matches.' : 'Empty folder.'}</Empty> : visible.map((e) => (
          <div key={e.rel} draggable onDragStart={(ev) => ev.dataTransfer.setData('text/rel', e.rel)} onDragOver={(ev) => { if (e.kind !== 'file') ev.preventDefault(); }} onDrop={onDrop(e)} data-testid="entry">
            <Row>
              <span className="w-6 text-center text-neutral-400">{icon(e)}</span>
              <button onClick={() => open(e)} className="min-w-0 flex-1 text-left">
                {renaming?.rel === e.rel ? <input autoFocus value={renaming.name} onClick={(ev) => ev.stopPropagation()} onChange={(ev) => setRenaming({ rel: e.rel, name: ev.target.value })} onKeyDown={(ev) => { if (ev.key === 'Enter') void rename(); if (ev.key === 'Escape') setRenaming(null); }} onBlur={() => setRenaming(null)} className="w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800" />
                  : <p className="truncate">{e.name}</p>}
                <p className="text-sm text-neutral-500">{e.kind === 'file' ? bytes(e.size) : e.kind}{e.kind !== 'file' ? '' : ` · ${ago(e.mtime)} ago`}</p>
              </button>
              {e.badge && <Pill tone={tone(e.badge.state)}>{PRODUCTION[e.badge.state] ?? e.badge.state}</Pill>}
              {e.badge && !e.badge.available && <Pill tone="red">{e.badge.transferPending ? 'transfer pending' : 'unavailable'}</Pill>}
              {e.badge?.transferPending && e.id && <Button kind="secondary" onClick={() => void run(() => api(`/api/projects/${e.id}/approve-transfer`, { method: 'POST' }), 'Transfer approved')}>Approve</Button>}
              <button onClick={() => setMenu(e)} aria-label={`Actions for ${e.name}`} className="min-h-11 min-w-11 text-neutral-500">…</button>
            </Row>
          </div>))}
      </div>
      <Sheet open={!!menu} onClose={() => setMenu(null)} title={menu?.name}>
        {menu && <div className="space-y-1">
          {menu.kind === 'file' && <Button kind="secondary" className="w-full" onClick={() => { open(menu); setMenu(null); }}>Download</Button>}
          {shareable(menu) && projectOf(menu.rel)?.id && <Button kind="secondary" className="w-full" onClick={() => { const p = projectOf(menu.rel)!; const rel = menu.rel.slice(p.rel.length + 1); void run(() => api(`/api/projects/${p.id}/share-file`, { method: 'POST', body: JSON.stringify({ rel, shared: true }) }), 'Shared with client'); setMenu(null); }}>Share with client</Button>}
          <Button kind="secondary" className="w-full" onClick={() => { setRenaming({ rel: menu.rel, name: menu.name }); setMenu(null); }}>Rename</Button>
          <Button kind="secondary" className="w-full" onClick={() => { void openMove(menu.rel); setMenu(null); }}>Move…</Button>
          <Button kind="danger" className="w-full" onClick={() => { void trashIt(menu.rel); setMenu(null); }}>Move to Trash</Button>
        </div>}
      </Sheet>
      <Sheet open={!!moving} onClose={() => setMoving(null)} title={`Move ${moving?.rel.split('/').pop() ?? ''} to…`}>
        {moving && <div>
          <p className="mb-2 text-sm text-neutral-500">Photos{moving.dir ? ` / ${moving.dir.replace(/\//g, ' / ')}` : ''}</p>
          <div className="max-h-64 overflow-y-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
            {moving.dir && <button onClick={() => void moveBrowse(moving.dir.split('/').slice(0, -1).join('/'))} className="block min-h-11 w-full px-3 text-left text-blue-600">‹ Up</button>}
            {moving.dirs.filter((d) => d.rel !== moving.rel).map((d) => <button key={d.rel} onClick={() => void moveBrowse(d.rel)} className="block min-h-11 w-full px-3 text-left">{icon(d)} {d.name}</button>)}
          </div>
          <Button className="mt-3 w-full" onClick={() => void move(moving.rel, `${moving.dir ? moving.dir + '/' : ''}${moving.rel.split('/').pop()}`)}>Move here</Button>
        </div>}
      </Sheet>
      <Sheet open={!!confirmMove} onClose={() => setConfirmMove(null)} title="Move to another client?">
        <p className="text-neutral-600 dark:text-neutral-400">The new client's emails will gain access to this project and the old client's will lose it. Picks, comments, and history stay with the project.</p>
        <Button className="mt-4 w-full" onClick={() => confirmMove && void move(confirmMove.from, confirmMove.to, true)}>Confirm move</Button>
      </Sheet>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </Shell>);
}
