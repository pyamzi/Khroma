import { useEffect, useState } from 'react';
import { api } from './api';
import { useRoute } from './router';
import { Setup } from './pages/Setup';
import { SignIn } from './pages/SignIn';
import { Home } from './pages/Home';
import { ProjectHome } from './pages/ProjectHome';
import { Cull } from './pages/Cull';
import { Dashboard } from './admin/Dashboard';
import { Settings } from './admin/Settings';
import { Files } from './admin/Files';
import { Clients } from './admin/Clients';
import { Project } from './admin/Project';

type Health = { setup: 'unconfigured' | 'awaiting_verification' | 'complete'; email: boolean };
export type Me = { kind: string; subject: string; isAdmin: boolean };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const route = useRoute();
  useEffect(() => { void api<Health>('/healthz').then(setHealth); void api<Me>('/api/me').then(setMe).catch(() => setMe(null)); }, []);
  if (!health || me === undefined) return null;
  if (route.name === 'setup' || health.setup !== 'complete') return <Setup state={health.setup} />;
  if (!me) return <SignIn />;
  if (route.name.startsWith('admin') && !me.isAdmin) return <Home me={me} />;
  if (route.name === 'admin') return <Dashboard />;
  if (route.name === 'admin_files') return <Files />;
  if (route.name === 'admin_clients') return <Clients />;
  if (route.name === 'admin_client') return <Clients id={route.params.id!} />;
  if (route.name === 'admin_project') return <Project id={route.params.id!} me={me} />;
  if (route.name === 'admin_settings') return <Settings me={me} />;
  if (route.name === 'home' && me.isAdmin) return <Dashboard />;
  if (route.name === 'project') return <ProjectHome id={route.params.id!} me={me} />;
  if (route.name === 'cull') return <Cull id={route.params.id!} me={me} />;
  return <Home me={me} />;
}
