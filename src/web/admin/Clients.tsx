import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { navigate } from '../router';
import { Shell } from './Shell';
import { Button, Empty, Input, Pill, Row, Toast } from './ui';
import { Sheet } from '../components/Sheet';
import { PRODUCTION, type ClientRow, type ClientDetail, type Settings } from './api';

export function Clients({ id }: { id?: string }) {
  const [list, setList] = useState<ClientRow[]>([]); const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [q, setQ] = useState(''); const [toast, setToast] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'client' | 'project' | null>(null);
  const [nc, setNc] = useState({ name: '', emails: '' }); const [np, setNp] = useState({ title: '', date: '', included: '', extraPrice: '' });
  const [edit, setEdit] = useState<{ name: string; emails: string; phone: string; notes: string } | null>(null);
  const load = async () => {
    if (id) { const d = await api<ClientDetail>(`/api/clients/${id}`); setDetail(d); setEdit({ name: d.name, emails: d.emails.join(', '), phone: d.phone ?? '', notes: d.notes ?? '' }); }
    else setList(await api<ClientRow[]>('/api/clients'));
  };
  useEffect(() => { void load().catch(() => navigate('/admin/clients')); }, [id]);
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setToast(ok); await load(); return true; } catch (e) { setToast(e instanceof ApiError ? `Error: ${e.message}` : 'Something went wrong'); return false; } };
  const emails = (s: string) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

  const createClient = async (e: FormEvent) => { e.preventDefault(); const r = await api<{ id: string }>('/api/clients', { method: 'POST', body: JSON.stringify({ name: nc.name, emails: emails(nc.emails) }) }).catch((err) => { setToast(err instanceof ApiError ? err.message : 'Failed'); return null; }); if (r) { setSheet(null); navigate(`/admin/clients/${r.id}`); } };
  const createProject = async (e: FormEvent) => {
    e.preventDefault(); if (!id) return;
    const st = await api<Settings>('/api/settings');
    const body = { clientId: id, title: np.title, date: np.date || null, included: np.included === '' ? st.studio.defaultIncluded : Number(np.included), extraPrice: np.extraPrice === '' ? st.studio.defaultExtraPrice : Number(np.extraPrice) };
    const r = await api<{ id: string }>('/api/projects', { method: 'POST', body: JSON.stringify(body) }).catch((err) => { setToast(err instanceof ApiError ? err.message : 'Failed'); return null; });
    if (r) { setSheet(null); navigate(`/admin/projects/${r.id}`); }
  };
  const saveClient = (e: FormEvent) => { e.preventDefault(); if (!edit) return; void run(() => api(`/api/clients/${id}`, { method: 'PATCH', body: JSON.stringify({ name: edit.name, emails: emails(edit.emails), phone: edit.phone, notes: edit.notes }) }), 'Saved'); };

  if (id) {
    if (!detail || !edit) return <Shell section="/admin/clients" title="Client"><Empty>Loading…</Empty></Shell>;
    return (
      <Shell section="/admin/clients" title={detail.name} actions={<Button onClick={() => setSheet('project')}>New project</Button>}>
        <button onClick={() => navigate('/admin/clients')} className="mb-3 min-h-9 text-blue-600">‹ Clients</button>
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-neutral-900"><h2 className="mb-3 text-lg font-semibold">Projects</h2>
            {detail.projects.length === 0 ? <Empty>No projects yet.</Empty> : detail.projects.map((p) => <Row key={p.id} onClick={() => navigate(`/admin/projects/${p.id}`)}><div className="flex-1"><p>{p.title}</p><p className="text-sm text-neutral-500">{p.date ?? 'No date'}</p></div><Pill tone={p.state.production === 'culling' ? 'amber' : p.state.production === 'delivered' ? 'green' : 'neutral'}>{PRODUCTION[p.state.production]}</Pill></Row>)}
          </section>
          <form onSubmit={saveClient} className="space-y-3 rounded-2xl bg-white p-5 shadow-sm dark:bg-neutral-900"><h2 className="text-lg font-semibold">Contact</h2>
            <Input label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required />
            <Input label="Emails (comma separated)" value={edit.emails} onChange={(e) => setEdit({ ...edit, emails: e.target.value })} />
            <Input label="Phone" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
            <Input label="Notes" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
            <Button>Save</Button>
            <p className="text-sm text-neutral-500">Folder: {detail.folderPath}</p>
          </form>
        </div>
        <Sheet open={sheet === 'project'} onClose={() => setSheet(null)} title="New project">
          <form onSubmit={createProject} className="space-y-3">
            <Input label="Title" required value={np.title} onChange={(e) => setNp({ ...np, title: e.target.value })} />
            <Input label="Date" type="date" value={np.date} onChange={(e) => setNp({ ...np, date: e.target.value })} />
            <div className="grid grid-cols-2 gap-3"><Input label="Included picks (blank = default)" type="number" value={np.included} onChange={(e) => setNp({ ...np, included: e.target.value })} /><Input label="Extra price, cents (blank = default)" type="number" value={np.extraPrice} onChange={(e) => setNp({ ...np, extraPrice: e.target.value })} /></div>
            <Button className="w-full">Create</Button>
          </form>
        </Sheet>
        <Toast msg={toast} onDone={() => setToast(null)} />
      </Shell>);
  }
  const visible = list.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.emails.some((e) => e.includes(q.toLowerCase())));
  return (
    <Shell section="/admin/clients" title="Clients" actions={<Button onClick={() => setSheet('client')}>New client</Button>}>
      <Input placeholder="Search clients" value={q} onChange={(e) => setQ(e.target.value)} className="!mt-0 mb-3 max-w-sm" />
      <div className="rounded-2xl bg-white px-4 shadow-sm dark:bg-neutral-900">
        {visible.length === 0 ? <Empty>{q ? 'No matches.' : 'No clients yet. Create one, or drop a client folder into Photos/Clients.'}</Empty> : visible.map((c) => (
          <Row key={c.id} onClick={() => navigate(`/admin/clients/${c.id}`)}><div className="min-w-0 flex-1"><p>{c.name}</p><p className="truncate text-sm text-neutral-500">{c.emails.join(', ') || 'no email'}</p></div><span className="text-sm text-neutral-500">{c.projects} project{c.projects === 1 ? '' : 's'}</span>{!c.available && <Pill tone="red">unavailable</Pill>}</Row>))}
      </div>
      <Sheet open={sheet === 'client'} onClose={() => setSheet(null)} title="New client">
        <form onSubmit={createClient} className="space-y-3">
          <Input label="Name" required value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} />
          <Input label="Emails (comma separated)" value={nc.emails} onChange={(e) => setNc({ ...nc, emails: e.target.value })} placeholder="sarah@example.com, tom@example.com" />
          <Button className="w-full">Create</Button>
        </form>
      </Sheet>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </Shell>);
}
