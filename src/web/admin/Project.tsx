import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { navigate } from '../router';
import type { Me } from '../App';
import type { PhotoItem, ProjectDetail } from '../types';
import { Viewer } from '../components/Viewer';
import { Sheet } from '../components/Sheet';
import { Shell } from './Shell';
import { Button, Empty, Input, Pill, Row, Segmented, Select, Toast } from './ui';
import { PRODUCTION, ago, publishFinals, type EventRow, type Insights, type User } from './api';

type Seg = 'photos' | 'activity' | 'insights' | 'details';
type Detail = ProjectDetail;
type Full = { title: string; date: string | null; assignedTo: string | null; downloads: 'client' | 'password' | 'none'; comments: { culling: boolean; finals: boolean }; notifyOnPublish: boolean; expiresAt: string | null };
const EVENT: Record<string, string> = { picked: 'picked a photo', unpicked: 'unpicked a photo', commented: 'commented', comment_resolved: 'resolved a comment', finished_culling: 'finished picking', finals_published: 'published finals', extras_requested: 'asked for extra photos', slots_granted: 'granted slots', allowance_changed: 'changed the allowance', price_changed: 'changed the extra price', production_changed: 'moved the project', viewed: 'viewed the project', project_updated: 'updated details', project_created: 'created the project', preview_failed: 'preview failed', replaced_externally: 'replaced a live final on disk', media_renamed_externally: 'renamed a media file on disk', photo_remapped: 'relinked a photo', round_cancelled: 'cancelled the round', transferred: 'transferred the project', reordered: 'reordered finals', uploaded: 'uploaded a file', trashed: 'moved to trash', restored: 'restored from trash' };

export function Project({ id, me }: { id: string; me: Me }) {
  const [p, setP] = useState<Detail | null>(null); const [seg, setSeg] = useState<Seg>('photos');
  const [stage, setStage] = useState<'culling' | 'final'>('culling'); const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]); const [insights, setInsights] = useState<Insights | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState<Full | null>(null); const [open, setOpen] = useState<number | null>(null);
  const [sheet, setSheet] = useState<null | 'grant' | 'allowance' | 'price' | 'more'>(null); const [num, setNum] = useState('');
  const [toast, setToast] = useState<string | null>(null); const [drag, setDrag] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await api<Detail>(`/api/projects/${id}`); setP(d);
    setStage((s) => (d.state.production === 'delivered' ? 'final' : s));
  }, [id]);
  useEffect(() => { void load().catch(() => navigate('/admin')); void api<User[]>('/api/users').then(setUsers); }, [load]);
  useEffect(() => { if (!p) return; void api<PhotoItem[]>(`/api/projects/${id}/photos?stage=${stage}`).then(setPhotos); }, [p, stage, id]);
  useEffect(() => {
    if (!p) return;
    if (seg === 'activity') void api<EventRow[]>(`/api/projects/${id}/events`).then(setEvents);
    if (seg === 'insights') void api<Insights>(`/api/projects/${id}/insights`).then(setInsights);
    if (seg === 'details') { void api<{ title: string; date: string | null; assignedTo?: string | null; downloads?: Full['downloads']; comments: Full['comments']; notifyOnPublish?: boolean; expiresAt?: string | null }>(`/api/projects/${id}`).then((d) => setForm({ title: d.title, date: d.date, assignedTo: d.assignedTo ?? null, downloads: d.downloads ?? 'client', comments: d.comments, notifyOnPublish: d.notifyOnPublish ?? false, expiresAt: d.expiresAt ?? null })); }
  }, [seg, p, id]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) setToast(ok); await load(); return true; } catch (e) { setToast(e instanceof ApiError ? `Error: ${e.message}` : 'Something went wrong'); return false; } };
  const post = (path: string, body: unknown, method = 'POST') => api(`/api/projects/${id}${path}`, { method, body: JSON.stringify(body) });

  if (!p) return <Shell section="/admin/projects" title="Project"><Empty>Loading…</Empty></Shell>;
  const s = p.selection; const prod = p.state.production;
  const saveTitle = () => { if (title !== null && title.trim() && title !== p.title) void run(() => post('', { title: title.trim() }, 'PATCH'), 'Renamed'); setTitle(null); };
  const submitNum = (e: FormEvent) => {
    e.preventDefault(); const n = Number(num); if (!Number.isFinite(n)) return;
    const call = sheet === 'grant' ? post('/grant', { delta: Math.trunc(n) }) : sheet === 'allowance' ? post('/allowance', { included: Math.trunc(n) }) : post('/price', { extraPrice: Math.round(n * 100) });
    void run(() => call, 'Done').then(() => { setSheet(null); setNum(''); });
  };
  const reorder = async (fromId: string, toId: string) => {
    const ids = photos.map((x) => x.id); const a = ids.indexOf(fromId); const b = ids.indexOf(toId); if (a < 0 || b < 0 || a === b) return;
    ids.splice(b, 0, ids.splice(a, 1)[0]!); setPhotos(ids.map((x) => photos.find((y) => y.id === x)!));
    await run(() => post('/photos/order', { ids }));
  };
  const publish = async () => {
    try {
      const drafts = (await api<PhotoItem[]>(`/api/projects/${id}/photos?stage=final`)).filter((x) => x.hasDraft).map((x) => x.id);
      let n = 0; let v = p.stateVersion; // the server takes 200 ids at most: send 100 at a time, each batch on the fresh version the previous one produced
      for (let i = 0; i < drafts.length; i += 100) {
        if (i) v = (await api<Detail>(`/api/projects/${id}`)).stateVersion;
        n += (await publishFinals(id, drafts.slice(i, i + 100), v)).published;
      }
      setToast(`Published ${n}`);
    } catch (e) { setToast(e instanceof ApiError && e.status === 409 ? 'The project changed. Reloaded; try again.' : e instanceof ApiError ? `Error: ${e.message}` : 'Something went wrong'); }
    await load();
  };
  const saveDetails = (e: FormEvent) => { e.preventDefault(); if (form) void run(() => post('', form, 'PATCH'), 'Saved'); };

  const actions = <>
    {prod === 'not_started' && <Button onClick={() => void run(() => post('/shot', {}), 'Marked as shot')}>Mark shot</Button>}
    {prod === 'culling' && <><Button onClick={() => setSheet('grant')}>Grant slots</Button><Button kind="secondary" onClick={() => setSheet('allowance')}>Allowance</Button></>}
    {(prod === 'editing' || prod === 'delivered') && p.counts.drafts > 0 && <Button onClick={() => void publish()}>Publish {p.counts.drafts}</Button>}
    <Button kind="secondary" onClick={() => setSheet('more')} aria-label="More actions">…</Button>
  </>;

  return (
    <Shell section="/admin/projects" title={p.title} actions={actions}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
        <span>{p.date ?? 'No date'}</span>
        <Pill tone={prod === 'culling' ? 'amber' : prod === 'editing' ? 'blue' : prod === 'delivered' ? 'green' : 'neutral'}>{PRODUCTION[prod]}</Pill>
        <span className="ml-auto">{s.confirmed + s.pending} of {s.entitlement} picked{s.pending ? ` · ${s.pending} pending` : ''}{s.deficit ? ` · deficit ${s.deficit}` : ''}</span>
      </div>
      <div className="mb-4"><Segmented value={seg} options={[['photos', 'Photos'], ['activity', 'Activity'], ['insights', 'Insights'], ['details', 'Details']]} onChange={setSeg} /></div>

      {seg === 'photos' && <>
        <div className="mb-2 flex items-center gap-3"><Segmented value={stage} options={[['culling', `Culling · ${p.counts.culling}`], ['final', `Finals · ${p.counts.final}${p.counts.drafts ? ` (+${p.counts.drafts} drafts)` : ''}`]]} onChange={setStage} />{stage === 'final' && <span className="text-sm text-neutral-500">Drag to reorder</span>}</div>
        {photos.length === 0 ? <Empty>{stage === 'culling' ? 'No RAWs yet.' : 'No finals yet. Publish from Lightroom.'}</Empty> : (
          <div className="grid grid-cols-3 gap-1 md:grid-cols-6">
            {photos.map((x, i) => (
              <div key={x.id} draggable={stage === 'final'} onDragStart={() => setDrag(x.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag) void reorder(drag, x.id); setDrag(null); }}
                className={`relative aspect-square bg-neutral-200 dark:bg-neutral-800 ${x.pick?.state === 'pending' ? 'ring-2 ring-inset ring-amber-400' : ''}`} data-testid="admin-tile">
                <button onClick={() => setOpen(i)} className="absolute inset-0" aria-label="Open photo">{x.previewReady && <img src={`/api/photos/${x.id}/preview?size=thumb&v=${x.v}`} loading="lazy" className="h-full w-full object-cover" alt="" />}</button>
                {x.hasDraft && <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-xs text-white">Draft</span>}
                {!x.previewReady && <span className="absolute inset-x-1 top-1 rounded bg-red-600/80 px-1 text-center text-xs text-white">No preview</span>}
                {x.comments.total > 0 && <span className="absolute left-1 bottom-1 rounded-full bg-black/60 px-1.5 text-xs text-white">{x.comments.open ? `${x.comments.open} open` : x.comments.total}</span>}
                {x.pick && <span className={`absolute right-1 bottom-1 rounded-full px-1.5 text-xs ${x.pick.state === 'pending' ? 'bg-amber-400 text-black' : 'bg-white text-red-500'}`}>{x.pick.locked ? '♥ ✓' : '♥'}</span>}
                {stage === 'final' && !x.hasDraft && <button onClick={() => void run(() => post('/cover', { photoId: x.id }), 'Cover set')} className="absolute right-1 top-1 rounded bg-black/60 px-1 text-xs text-white">Cover</button>}
              </div>))}
          </div>)}
        {open !== null && <Viewer photos={photos} index={open} me={me} commentsOn onIndex={setOpen} onClose={() => setOpen(null)} onToggle={() => setToast('Picks belong to the client. Use Grant slots or Allowance.')} onCommented={() => void load()} onResolve={async (cid, resolved) => { await api(`/api/comments/${cid}/resolve`, { method: 'POST', body: JSON.stringify({ resolved }) }); void load(); }} />}
      </>}

      {seg === 'activity' && <div className="rounded-2xl bg-white px-4 shadow-sm dark:bg-neutral-900">
        {events.length === 0 ? <Empty>Nothing yet.</Empty> : events.map((e) => <Row key={e.id}><div className="min-w-0 flex-1"><p><span className="font-medium">{e.actor === me.subject ? 'You' : e.actor}</span> {EVENT[e.type] ?? e.type}{typeof e.payload.count === 'number' ? ` (${e.payload.count})` : ''}{typeof e.payload.delta === 'number' ? ` (${e.payload.delta > 0 ? '+' : ''}${e.payload.delta})` : ''}</p></div><span className="text-sm text-neutral-400">{ago(e.at)} ago</span></Row>)}
      </div>}

      {seg === 'insights' && (!insights ? <Empty>Loading…</Empty> : <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-neutral-900"><h2 className="mb-2 text-lg font-semibold">Activity</h2>
          <p className="text-3xl font-semibold">{insights.views} <span className="text-base font-normal text-neutral-500">views · {insights.uniqueVisitors} visitor{insights.uniqueVisitors === 1 ? '' : 's'}</span></p>
          <div className="mt-4 flex h-24 items-end gap-0.5">{insights.byDay.slice(-30).map((d) => { const v = d.views + d.picks + d.comments; const max = Math.max(1, ...insights.byDay.map((x) => x.views + x.picks + x.comments)); return <div key={d.day} title={`${d.day}: ${d.views} views, ${d.picks} picks, ${d.comments} comments`} className="flex-1 rounded-t bg-blue-500" style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />; })}</div>
          {insights.byDay.length === 0 && <Empty>No activity yet.</Empty>}
        </section>
        <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-neutral-900"><h2 className="mb-2 text-lg font-semibold">Visitors</h2>
          {insights.visitors.length === 0 ? <Empty>No one has opened it yet.</Empty> : insights.visitors.map((v) => <Row key={v.actor}><span className="flex-1">{v.actor}</span><span className="text-sm text-neutral-500">{v.views} view{v.views === 1 ? '' : 's'} · {ago(v.lastSeen)} ago</span></Row>)}
        </section>
      </div>)}

      {seg === 'details' && form && <div className="grid gap-4 md:grid-cols-2">
        <form onSubmit={saveDetails} className="space-y-3 rounded-2xl bg-white p-5 shadow-sm dark:bg-neutral-900"><h2 className="text-lg font-semibold">Details</h2>
          <Input label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
          <Input label="Date" type="date" value={form.date ?? ''} onChange={(e) => setForm({ ...form, date: e.target.value || null })} />
          <Select label="Assigned to" value={form.assignedTo ?? ''} onChange={(e) => setForm({ ...form, assignedTo: e.target.value || null })}><option value="">Nobody</option>{users.map((u) => <option key={u.id} value={u.email}>{u.email}</option>)}</Select>
          <Select label="Downloads" value={form.downloads} onChange={(e) => setForm({ ...form, downloads: e.target.value as Full['downloads'] })}><option value="client">Client only</option><option value="password">Anyone with the password</option><option value="none">Nobody</option></Select>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={form.comments.culling} onChange={(e) => setForm({ ...form, comments: { ...form.comments, culling: e.target.checked } })} /> Comments during culling</label>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={form.comments.finals} onChange={(e) => setForm({ ...form, comments: { ...form.comments, finals: e.target.checked } })} /> Comments on finals</label>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={form.notifyOnPublish} onChange={(e) => setForm({ ...form, notifyOnPublish: e.target.checked })} /> Notify client automatically on publish</label>
          <Input label="Gallery expires" type="date" value={form.expiresAt?.slice(0, 10) ?? ''} onChange={(e) => setForm({ ...form, expiresAt: e.target.value || null })} />
          <Button>Save</Button>
          <div className="border-t border-neutral-200 pt-3 text-sm text-neutral-500 dark:border-neutral-800">
            <p>Allowance: {s.included} included · {s.entitlement} total slots · ${(s.extraPrice / 100).toFixed(2)} per extra</p>
            <div className="mt-2 flex flex-wrap gap-2"><Button kind="secondary" type="button" onClick={() => setSheet('allowance')}>Change allowance</Button><Button kind="secondary" type="button" onClick={() => setSheet('grant')}>Grant slots</Button><Button kind="secondary" type="button" onClick={() => setSheet('price')}>Change price</Button></div>
            <p className="mt-3">Booking {p.state.booking} · production {prod}</p>
          </div>
        </form>
      </div>}

      <Sheet open={sheet === 'grant' || sheet === 'allowance' || sheet === 'price'} onClose={() => setSheet(null)} title={sheet === 'grant' ? 'Grant extra slots' : sheet === 'allowance' ? 'Set included picks' : 'Extra photo price'}>
        <form onSubmit={submitNum} className="space-y-3">
          <Input label={sheet === 'grant' ? 'Slots to add (negative to remove)' : sheet === 'allowance' ? 'Included picks' : 'Price per extra photo (dollars)'} type="number" step={sheet === 'price' ? '0.01' : '1'} autoFocus required value={num} onChange={(e) => setNum(e.target.value)} />
          {sheet === 'allowance' && s.submitted > 0 && <p className="text-sm text-neutral-500">Cannot go below the {s.submitted} picks already submitted.</p>}
          <Button className="w-full">Apply</Button>
        </form>
      </Sheet>
      <Sheet open={sheet === 'more'} onClose={() => setSheet(null)} title="More">
        <div className="space-y-1">
          <Button kind="secondary" className="w-full" onClick={() => { setSheet(null); setTitle(p.title); const t = prompt('Rename project', p.title); if (t !== null) { setTitle(t); setTimeout(saveTitle, 0); } }}>Rename</Button>
          <Button kind="secondary" className="w-full" onClick={() => { setSheet(null); setSheet('price'); }}>Change extra price</Button>
          {prod === 'culling' && <Button kind="secondary" className="w-full" onClick={() => { setSheet(null); if (confirm('Clear all current picks for this round?')) void run(() => post('/cancel-round', {}), 'Round cancelled'); }}>Cancel round</Button>}
          <Button kind="secondary" className="w-full" onClick={() => window.open(`/p/${id}`, '_blank')}>Open as client</Button>
        </div>
      </Sheet>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </Shell>);
}
