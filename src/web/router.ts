import { useEffect, useState } from 'react';

export type Route = { name: 'home' | 'project' | 'cull' | 'gallery' | 'signup' | 'signin' | 'admin' | 'admin_projects' | 'admin_clients' | 'admin_client' | 'admin_project' | 'admin_settings' | 'unknown'; params: Record<string, string> };
const PATTERNS: [RegExp, Route['name'], string[]][] = [
  [/^\/$/, 'home', []], [/^\/p\/([^/]+)$/, 'project', ['id']], [/^\/p\/([^/]+)\/cull$/, 'cull', ['id']], [/^\/p\/([^/]+)\/gallery$/, 'gallery', ['id']], [/^\/signup$/, 'signup', []], [/^\/signin$/, 'signin', []],
  [/^\/admin$/, 'admin', []], [/^\/admin\/projects$/, 'admin_projects', []], [/^\/admin\/clients$/, 'admin_clients', []], [/^\/admin\/clients\/([^/]+)$/, 'admin_client', ['id']], [/^\/admin\/projects\/([^/]+)$/, 'admin_project', ['id']], [/^\/admin\/settings$/, 'admin_settings', []],
];
export function match(pathname: string): Route {
  for (const [re, name, keys] of PATTERNS) { const m = pathname.match(re); if (m) return { name, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])) }; }
  return { name: 'unknown', params: {} };
}
export function navigate(path: string) { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }
export function useRoute(): Route {
  const [r, setR] = useState(() => match(window.location.pathname));
  useEffect(() => { const on = () => setR(match(window.location.pathname)); window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on); }, []);
  return r;
}
