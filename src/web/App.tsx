import { useEffect, useState } from 'react';
import { api } from './api';
import { Setup } from './pages/Setup';
import { SignIn } from './pages/SignIn';
import { Home } from './pages/Home';

type Health = { setup: 'unconfigured' | 'awaiting_verification' | 'complete'; email: boolean };
export type Me = { kind: string; subject: string; isAdmin: boolean };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => { void api<Health>('/healthz').then(setHealth); void api<Me>('/api/me').then(setMe).catch(() => setMe(null)); }, []);
  const path = window.location.pathname;
  if (!health || me === undefined) return null;
  if (path === '/setup' || health.setup !== 'complete') return <Setup state={health.setup} />;
  if (!me) return <SignIn />;
  return <Home me={me} />;
}
