import { useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import type { Me } from '../App';

type Project = { id: string; title: string; date: string | null; state: { production: string } };
const label: Record<string, string> = { not_started: 'Waiting for photos', shot: 'Waiting for photos', culling: 'Pick your favorites', editing: "We're editing", delivered: 'Your gallery is ready' };

export function Home({ me }: { me: Me }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  useEffect(() => { void api<Project[]>('/api/projects').then((ps) => { if (!me.isAdmin && ps.length === 1) navigate(`/p/${ps[0]!.id}`); else setProjects(ps); }); }, [me.isAdmin]);
  const signout = async () => { await api('/api/auth/signout', { method: 'POST' }); window.location.href = '/'; };
  if (!projects) return null;
  return (
    <main className="mx-auto max-w-2xl p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold">{me.isAdmin ? 'Projects' : 'Your projects'}</h1>
        <button onClick={signout} className="min-h-11 text-sm text-neutral-500">Sign out</button>
      </header>
      <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
        {projects.map((p) => (
          <li key={p.id}><button onClick={() => navigate(`/p/${p.id}`)} className="flex min-h-11 w-full items-center justify-between py-4 text-left">
            <span><span className="block text-lg">{p.title}</span><span className="text-sm text-neutral-500">{p.date ?? 'No date'} · {label[p.state.production] ?? p.state.production}</span></span>
            <span className="text-neutral-400">›</span></button></li>))}
        {projects.length === 0 && <li className="py-8 text-neutral-500">Nothing here yet.</li>}
      </ul>
    </main>);
}
