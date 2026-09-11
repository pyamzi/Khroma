import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Me } from '../App';

type Project = { id: string; title: string; date: string | null; state: { booking: string; production: string } };
type Photo = { id: string; stage: string; width: number | null; height: number | null };

export function Home({ me }: { me: Me }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState<Project | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  useEffect(() => { void api<Project[]>('/api/projects').then(setProjects); }, []);
  useEffect(() => { if (open) void api<Photo[]>(`/api/projects/${open.id}/photos`).then(setPhotos); }, [open]);
  const signout = async () => { await api('/api/auth/signout', { method: 'POST' }); window.location.reload(); };

  if (open) return (
    <main className="p-2">
      <button onClick={() => setOpen(null)} className="min-h-11 px-3 text-blue-600">‹ Back</button>
      <h1 className="px-3 text-2xl font-semibold">{open.title}</h1>
      <div className="mt-3 grid grid-cols-3 gap-0.5">
        {photos.map((p) => <img key={p.id} src={`/api/photos/${p.id}/preview?size=thumb`} loading="lazy" className="aspect-square w-full bg-neutral-200 object-cover dark:bg-neutral-800" alt="" />)}
      </div>
      {photos.length === 0 && <p className="p-3 text-neutral-500">No photos yet.</p>}
    </main>);
  return (
    <main className="mx-auto max-w-2xl p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold">{me.isAdmin ? 'Projects' : 'Your projects'}</h1>
        <button onClick={signout} className="min-h-11 text-sm text-neutral-500">Sign out</button>
      </header>
      <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
        {projects.map((p) => (
          <li key={p.id}><button onClick={() => setOpen(p)} className="flex min-h-11 w-full items-center justify-between py-4 text-left">
            <span><span className="block text-lg">{p.title}</span><span className="text-sm text-neutral-500">{p.date ?? 'No date'} · {p.state.production.replace('_', ' ')}</span></span>
            <span className="text-neutral-400">›</span></button></li>))}
        {projects.length === 0 && <li className="py-8 text-neutral-500">Nothing here yet.</li>}
      </ul>
    </main>);
}
