import { useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { Shell } from './Shell';
import { Input, Segmented, Toast } from './ui';
import { PRODUCTION, type ProjectSummary, type ClientRow } from './api';

const COLS = ['not_started', 'shot', 'culling', 'editing', 'delivered'] as const;
const GUARD: Record<string, string> = { culling: 'Culling starts by itself when the first RAW arrives.', editing: 'Editing starts when the client finishes picking.', delivered: 'Delivered happens when you publish finals.', not_started: 'A project cannot go back to not started.' };

/** Every project by production stage. Dragging not started → shot is the one manual move. */
export function Board() {
  const [projects, setProjects] = useState<(ProjectSummary & { client: string })[]>([]);
  const [filter, setFilter] = useState<'active' | 'archived'>('active'); const [q, setQ] = useState(''); const [drag, setDrag] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const load = async () => {
    const [ps, cs] = await Promise.all([api<ProjectSummary[]>('/api/projects'), api<ClientRow[]>('/api/clients')]);
    const names = new Map(cs.map((c) => [c.id, c.name])); setProjects(ps.map((p) => ({ ...p, client: names.get(p.clientId) ?? '' })));
  };
  useEffect(() => { void load(); }, []);
  const cards = projects.filter((p) => (filter === 'archived' ? p.state.archivedAt : !p.state.archivedAt)).filter((p) => !q || `${p.title} ${p.client}`.toLowerCase().includes(q.toLowerCase()));
  const dropCol = (col: string) => async (ev: React.DragEvent) => {
    ev.preventDefault(); const p = projects.find((x) => x.id === drag); setDrag(null); if (!p || p.state.production === col) return;
    if (p.state.production === 'not_started' && col === 'shot') { try { await api(`/api/projects/${p.id}/shot`, { method: 'POST' }); await load(); } catch { setToast('Could not mark as shot'); } } else setToast(GUARD[col] ?? 'That move is not available.');
  };
  return (
    <Shell section="/admin/projects" title="Board">
      <div className="mb-3 flex flex-wrap items-center gap-2"><Segmented value={filter} options={[['active', 'Active'], ['archived', 'Archived']]} onChange={setFilter} /><Input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="!mt-0 w-56" /></div>
      <div className="grid gap-3 md:grid-cols-5">
        {COLS.map((col) => (
          <div key={col} onDragOver={(e) => e.preventDefault()} onDrop={dropCol(col)} className="min-h-40 rounded-2xl bg-neutral-200/60 p-2 dark:bg-neutral-900">
            <p className="mb-2 px-1 text-sm font-medium text-neutral-600 dark:text-neutral-400">{PRODUCTION[col]}</p>
            {cards.filter((p) => p.state.production === col).map((p) => (
              <div key={p.id} draggable onDragStart={() => setDrag(p.id)} onClick={() => navigate(`/admin/projects/${p.id}`)} className="mb-2 cursor-pointer rounded-xl bg-white p-3 shadow-sm dark:bg-neutral-800" data-testid="card">
                <p className="font-medium">{p.title}</p><p className="text-sm text-neutral-500">{p.client}{p.date ? ` · ${p.date}` : ''}</p>
              </div>))}
          </div>))}
      </div>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </Shell>);
}
