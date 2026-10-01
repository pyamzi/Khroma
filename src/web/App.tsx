import { useEffect, useState } from 'react';
import { api } from './api';
import { useRoute } from './router';
import { Signup } from './pages/Signup';
import { SignIn } from './pages/SignIn';
import { Home } from './pages/Home';
import { ProjectHome } from './pages/ProjectHome';
import { Cull } from './pages/Cull';
import { Gallery } from './pages/Gallery';
import { Dashboard } from './admin/Dashboard';
import { Settings } from './admin/Settings';
import { Clients } from './admin/Clients';
import { Board } from './admin/Board';
import { Project } from './admin/Project';
import { Library } from './admin/Library';

export type Me = { kind: string; subject: string; isAdmin: boolean; studio?: { id: string; name: string } };

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const route = useRoute();
  useEffect(() => { void api<Me>('/api/me').then(setMe).catch(() => setMe(null)); }, []);
  if (route.name === 'signup') return <Signup />;
  if (me === undefined) return null;
  if (!me) return <SignIn />;
  if (route.name.startsWith('admin') && !me.isAdmin) return <Home me={me} />;
  if (route.name === 'admin') return <Dashboard />;
  if (route.name === 'admin_projects') return <Board />;
  if (route.name === 'admin_clients') return <Clients />;
  if (route.name === 'admin_client') return <Clients id={route.params.id!} />;
  if (route.name === 'admin_project') return <Project id={route.params.id!} me={me} />;
  if (route.name === 'admin_library') return <Library />;
  if (route.name === 'admin_settings') return <Settings me={me} />;
  if (route.name === 'home' && me.isAdmin) return <Dashboard />;
  if (route.name === 'project') return <ProjectHome id={route.params.id!} me={me} />;
  if (route.name === 'cull') return <Cull id={route.params.id!} me={me} />;
  if (route.name === 'gallery') return <Gallery id={route.params.id!} me={me} />;
  return <Home me={me} />;
}
