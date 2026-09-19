import { useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import type { Me } from '../App';
import type { ProjectDetail } from '../types';

export function ProjectHome({ id, me }: { id: string; me: Me }) {
  const [p, setP] = useState<ProjectDetail | null>(null);
  useEffect(() => { void api<ProjectDetail>(`/api/projects/${id}`).then(setP).catch(() => navigate('/')); }, [id]);
  if (!p) return null;
  const s = p.selection; const picked = s.confirmed + s.pending;
  const status: { line: string; cta: string | null; go: () => void; bar?: number } = (() => {
    switch (p.state.production) {
      case 'culling': return { line: `Pick your favorites · ${picked} of ${s.entitlement}`, cta: picked ? 'Continue' : 'Start picking', go: () => navigate(`/p/${id}/cull`) };
      case 'editing': return { line: `We're editing · ${p.progress.done} of ${p.progress.total} done`, cta: 'See your picks', go: () => navigate(`/p/${id}/cull`), bar: p.progress.total ? p.progress.done / p.progress.total : 0 };
      case 'delivered': return { line: 'Your gallery is ready', cta: 'Open gallery', go: () => navigate(`/p/${id}/cull`) };
      default: return { line: 'Your photos are on the way', cta: null, go: () => {} };
    }
  })();
  return (
    <main className="mx-auto max-w-2xl p-6">
      <button onClick={() => navigate('/')} className="min-h-11 text-blue-600">‹ {me.isAdmin ? 'Projects' : 'Your projects'}</button>
      <h1 className="mt-2 text-3xl font-semibold">{p.title}</h1>
      {p.date && <p className="text-neutral-500">{p.date}</p>}
      <section className="mt-8 rounded-2xl bg-neutral-100 p-5 dark:bg-neutral-900">
        <p className="text-lg">{status.line}</p>
        {status.bar !== undefined && <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-neutral-300 dark:bg-neutral-700"><div className="h-full bg-black dark:bg-white" style={{ width: `${Math.round(status.bar * 100)}%` }} /></div>}
        {status.cta && <button onClick={status.go} className="mt-4 min-h-11 w-full rounded-xl bg-black py-3 text-base font-medium text-white dark:bg-white dark:text-black">{status.cta}</button>}
      </section>
      <nav className="mt-8 divide-y divide-neutral-200 dark:divide-neutral-800">
        {['Documents', 'Share', 'Help'].map((t) => <div key={t} className="flex min-h-11 items-center justify-between py-3 text-neutral-400"><span>{t}</span><span className="text-xs">Coming soon</span></div>)}
      </nav>
    </main>);
}
