import { useEffect, useState } from 'react';
import { api } from './api';
import { useRoute } from './router';
import { Setup } from './pages/Setup';
import { SignIn } from './pages/SignIn';
import { Home } from './pages/Home';
import { ProjectHome } from './pages/ProjectHome';
import { Cull } from './pages/Cull';

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
  if (route.name === 'project') return <ProjectHome id={route.params.id!} me={me} />;
  if (route.name === 'cull') return <Cull id={route.params.id!} me={me} />;
  return <Home me={me} />;
}
