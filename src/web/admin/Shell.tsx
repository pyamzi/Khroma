import type { ReactNode } from 'react';
import { navigate } from '../router';
import { api } from '../api';

const NAV: [string, string, string][] = [['/admin', 'Dashboard', '⌂'], ['/admin/projects', 'Board', '▦'], ['/admin/clients', 'Clients', '☺'], ['/admin/library', 'Library', '▤'], ['/admin/settings', 'Settings', '⚙']];

export function Shell({ section, title, children, actions }: { section: string; title: string; children: ReactNode; actions?: ReactNode }) {
  const signout = async () => { await api('/api/auth/signout', { method: 'POST' }); window.location.href = '/'; };
  const item = ([path, label, icon]: [string, string, string], mobile: boolean) => {
    const active = section === path;
    return mobile
      ? <button key={path} onClick={() => navigate(path)} aria-current={active ? 'page' : undefined} className={`flex flex-1 flex-col items-center py-2 text-xs ${active ? 'text-blue-600' : 'text-neutral-500'}`}><span className="text-xl">{icon}</span>{label}</button>
      : <button key={path} onClick={() => navigate(path)} aria-current={active ? 'page' : undefined} className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left ${active ? 'bg-neutral-200 font-medium dark:bg-neutral-800' : 'text-neutral-700 dark:text-neutral-300'}`}><span className="w-5 text-center">{icon}</span>{label}</button>;
  };
  return (
    <div className="min-h-screen bg-neutral-100 dark:bg-black md:flex">
      <aside className="hidden w-60 shrink-0 flex-col gap-1 border-r border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950 md:flex">
        <p className="mb-4 px-3 text-lg font-semibold">Kreate</p>
        {NAV.map((n) => item(n, false))}
        <button disabled className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-neutral-400"><span className="w-5 text-center">▦</span>Calendar <span className="ml-auto text-xs">M6</span></button>
        <button onClick={signout} className="mt-auto min-h-11 px-3 text-left text-sm text-neutral-500">Sign out</button>
      </aside>
      <main className="flex-1 pb-24 md:pb-8">
        <header className="sticky top-0 z-10 flex items-center justify-between bg-neutral-100/90 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur dark:bg-black/80 md:px-8">
          <h1 className="text-2xl font-semibold md:text-3xl">{title}</h1><div className="flex gap-2">{actions}</div>
        </header>
        <div className="px-4 md:px-8">{children}</div>
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-neutral-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-neutral-800 dark:bg-black/90 md:hidden">{NAV.map((n) => item(n, true))}</nav>
    </div>);
}
