import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import type { Me } from '../App';
import { Shell } from './Shell';
import { Button, Card, Empty, Input, Select, Pill, Row, Toast } from './ui';
import { ago, type Settings as S, type User, type Job, type PluginToken } from './api';

const LATER = [['Integrations', 'M7–M8'], ['Templates', 'M8'], ['Forms', 'M8'], ['Packages', 'M8'], ['Offers', 'M9'], ['Music', 'M10'], ['MCP tokens', 'M10'], ['Calendar feed', 'M6']];

export function Settings({ me }: { me: Me }) {
  const [s, setS] = useState<S | null>(null); const [users, setUsers] = useState<User[]>([]); const [jobs, setJobs] = useState<Job[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [studio, setStudio] = useState<S['studio'] | null>(null);
  const [invite, setInvite] = useState({ email: '', role: 'member' });
  const [jobState, setJobState] = useState('');
  const [tokens, setTokens] = useState<PluginToken[]>([]); const [newToken, setNewToken] = useState({ name: '', scope: 'read+write' }); const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);
  const owner = users.find((u) => u.email === me.subject)?.role === 'owner';
  const load = async () => {
    const [st, us, js] = await Promise.all([api<S>('/api/settings'), api<User[]>('/api/users'), api<Job[]>(`/api/jobs${jobState ? `?state=${jobState}` : ''}`)]);
    setS(st); setStudio(st.studio); setUsers(us); setJobs(js); setTokens(await api<PluginToken[]>('/api/access/tokens'));
  };
  useEffect(() => { void load(); }, [jobState]);
  const run = async (fn: () => Promise<unknown>, ok = 'Saved') => { try { await fn(); setToast(ok); await load(); } catch (e) { setToast(e instanceof ApiError ? `Error: ${e.message}` : 'Something went wrong'); } };
  const saveStudio = (e: FormEvent) => { e.preventDefault(); if (studio) void run(() => api('/api/settings/studio', { method: 'PATCH', body: JSON.stringify(studio) })); };
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  if (!s || !studio) return <Shell section="/admin/settings" title="Settings"><Empty>Loading…</Empty></Shell>;
  return (
    <Shell section="/admin/settings" title="Settings">
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Studio">
          <form onSubmit={saveStudio} className="space-y-3">
            <Input label="Studio name" value={studio.studioName} onChange={(e) => setStudio({ ...studio, studioName: e.target.value })} disabled={!owner} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Timezone" value={studio.timezone} onChange={(e) => setStudio({ ...studio, timezone: e.target.value })} disabled={!owner} />
              <Input label="Currency (ISO)" value={studio.currency} onChange={(e) => setStudio({ ...studio, currency: e.target.value.toLowerCase() })} disabled={!owner} />
              <Input label="Default included picks" type="number" value={studio.defaultIncluded} onChange={(e) => setStudio({ ...studio, defaultIncluded: num(e.target.value) })} disabled={!owner} />
              <Input label="Default extra price (cents)" type="number" value={studio.defaultExtraPrice} onChange={(e) => setStudio({ ...studio, defaultExtraPrice: num(e.target.value) })} disabled={!owner} />
            </div>
            <Input label="Review link (Google / Yelp)" value={studio.reviewUrl} onChange={(e) => setStudio({ ...studio, reviewUrl: e.target.value })} disabled={!owner} />
            {owner ? <Button>Save</Button> : <p className="text-sm text-neutral-500">Only owners can change studio settings.</p>}
          </form>
        </Card>
        <Card title="Team">
          {users.map((u) => (
            <Row key={u.id}><div className="flex-1"><p>{u.email}{u.email === me.subject && <span className="text-neutral-400"> · you</span>}</p><p className="text-sm text-neutral-500">{u.role}</p></div>
              <select value={u.notifyDownloads} disabled={!owner && u.email !== me.subject} onChange={(e) => void run(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ notifyDownloads: e.target.value }) }))} className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" aria-label="Download notifications"><option value="off">Off</option><option value="digest">Daily digest</option><option value="each">Every download</option></select>
              {owner && <select value={u.role} onChange={(e) => void run(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) }))} className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" aria-label="Role"><option value="owner">owner</option><option value="member">member</option></select>}
              {owner && u.email !== me.subject && <Button kind="plain" onClick={() => { if (confirm(`Remove ${u.email}?`)) void run(() => api(`/api/users/${u.id}`, { method: 'DELETE' }), 'Removed'); }}>Remove</Button>}
            </Row>))}
          {owner && <form onSubmit={(e) => { e.preventDefault(); void run(() => api('/api/users/invite', { method: 'POST', body: JSON.stringify(invite) }), 'Invite sent').then(() => setInvite({ email: '', role: 'member' })); }} className="mt-4 flex flex-wrap items-end gap-2">
            <div className="flex-1"><Input label="Invite by email" type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></div>
            <Select label="Role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}><option value="member">member</option><option value="owner">owner</option></Select>
            <Button>Invite</Button></form>}
        </Card>
        <Card title="Jobs" action={<select value={jobState} onChange={(e) => setJobState(e.target.value)} className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" aria-label="Job state"><option value="">Open</option><option value="failed">Failed</option><option value="needs_review">Needs review</option><option value="done">Done</option></select>}>
          <div id="jobs" />
          {jobs.length === 0 ? <Empty>No jobs here.</Empty> : jobs.map((j) => (
            <Row key={j.id}><div className="min-w-0 flex-1"><p>{j.kind} <Pill tone={j.state === 'done' ? 'green' : j.state === 'pending' ? 'amber' : 'red'}>{j.state}</Pill></p><p className="truncate text-sm text-neutral-500">{j.lastError ?? `${j.attempts} attempts · ${ago(j.createdAt)} ago`}</p></div>
              {(j.state === 'failed' || j.state === 'needs_review') && <Button kind="secondary" onClick={() => void run(() => api(`/api/jobs/${j.id}/retry`, { method: 'POST' }), 'Retrying')}>Retry</Button>}</Row>))}
        </Card>
        <Card title="Access">
          <p className="mb-2 text-sm text-neutral-500">Tokens for the Lightroom plugin. A token is shown once; paste it into the plugin's settings.</p>
          {tokens.map((t) => <Row key={t.id}><div className="min-w-0 flex-1"><p>{t.name} <Pill tone={t.scope === 'read+write' ? 'blue' : 'neutral'}>{t.scope}</Pill></p><p className="text-sm text-neutral-500">by {t.createdBy} · {ago(t.createdAt)} ago{t.projectId ? ' · one project' : ''}</p></div><Button kind="plain" onClick={() => { if (confirm(`Revoke ${t.name}? Lightroom will stop syncing until a new token is entered.`)) void run(() => api(`/api/access/tokens/${t.id}`, { method: 'DELETE' }), 'Revoked'); }}>Revoke</Button></Row>)}
          {minted && <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm dark:bg-amber-950" data-testid="minted-token"><p className="font-medium">{minted.name}</p><code className="block break-all">{minted.token}</code><div className="mt-2 flex gap-2"><Button kind="secondary" type="button" onClick={() => void navigator.clipboard?.writeText(minted.token)}>Copy</Button><Button kind="plain" type="button" onClick={() => setMinted(null)}>Done</Button></div><p className="mt-1 text-neutral-500">This is the only time it is shown.</p></div>}
          <form onSubmit={(e) => { e.preventDefault(); void api<{ token: string }>('/api/access/tokens', { method: 'POST', body: JSON.stringify(newToken) }).then((r) => { setMinted({ name: newToken.name, token: r.token }); setNewToken({ name: '', scope: 'read+write' }); return load(); }).catch((err) => setToast(err instanceof ApiError ? `Error: ${err.message}` : 'Failed')); }} className="mt-4 flex flex-wrap items-end gap-2">
            <div className="flex-1"><Input label="New token name" required value={newToken.name} placeholder="Sam's MacBook" onChange={(e) => setNewToken({ ...newToken, name: e.target.value })} /></div>
            <Select label="Scope" value={newToken.scope} onChange={(e) => setNewToken({ ...newToken, scope: e.target.value })}><option value="read+write">read+write</option><option value="read">read</option></Select>
            <Button>Create token</Button></form>
        </Card>
        <Card title="Coming later">{LATER.map(([n, m]) => <Row key={n}><span className="flex-1 text-neutral-400">{n}</span><span className="text-xs text-neutral-400">{m}</span></Row>)}</Card>
      </div>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </Shell>);
}
