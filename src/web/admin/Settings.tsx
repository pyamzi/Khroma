import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import type { Me } from '../App';
import { Shell } from './Shell';
import { Button, Card, Empty, Input, Select, Pill, Row, Toast } from './ui';
import { ago, type Settings as S, type User, type Job, type Issue } from './api';

const LATER = [['Integrations', 'M7–M8'], ['Templates', 'M8'], ['Forms', 'M8'], ['Packages', 'M8'], ['Offers', 'M9'], ['Music', 'M10'], ['Access', 'M4']];

export function Settings({ me }: { me: Me }) {
  const [s, setS] = useState<S | null>(null); const [users, setUsers] = useState<User[]>([]); const [jobs, setJobs] = useState<Job[]>([]); const [issues, setIssues] = useState<Issue[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [studio, setStudio] = useState<S['studio'] | null>(null);
  const [email, setEmail] = useState({ type: 'smtp', url: '', from: '', token: '', templateId: '' });
  const [invite, setInvite] = useState({ email: '', role: 'member' });
  const [jobState, setJobState] = useState('');
  const owner = users.find((u) => u.email === me.subject)?.role === 'owner';
  const load = async () => {
    const [st, us, js, is] = await Promise.all([api<S>('/api/settings'), api<User[]>('/api/users'), api<Job[]>(`/api/jobs${jobState ? `?state=${jobState}` : ''}`), api<Issue[]>('/api/issues')]);
    setS(st); setStudio(st.studio); setUsers(us); setJobs(js); setIssues(is);
  };
  useEffect(() => { void load(); }, [jobState]);
  useEffect(() => { if (s?.email.lastTest?.state === 'pending' || s?.email.lastTest?.state === 'running') { const t = setTimeout(() => void api<S>('/api/settings').then(setS), 2000); return () => clearTimeout(t); } }, [s]);
  const run = async (fn: () => Promise<unknown>, ok = 'Saved') => { try { await fn(); setToast(ok); await load(); } catch (e) { setToast(e instanceof ApiError ? `Error: ${e.message}` : 'Something went wrong'); } };
  const saveStudio = (e: FormEvent) => { e.preventDefault(); if (studio) void run(() => api('/api/settings/studio', { method: 'PATCH', body: JSON.stringify(studio) })); };
  const saveEmail = (e: FormEvent) => { e.preventDefault(); const body = email.type === 'smtp' ? { type: 'smtp', url: email.url, from: email.from } : { type: 'listmonk', url: email.url, token: email.token, from: email.from, templateId: Number(email.templateId) }; void run(() => api('/api/settings/email', { method: 'PUT', body: JSON.stringify(body) })); };
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  if (!s || !studio) return <Shell section="/admin/settings" title="Settings"><Empty>Loading…</Empty></Shell>;
  const lt = s.email.lastTest;
  return (
    <Shell section="/admin/settings" title="Settings">
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Studio">
          <form onSubmit={saveStudio} className="space-y-3">
            <Input label="Studio name" value={studio.studioName} onChange={(e) => setStudio({ ...studio, studioName: e.target.value })} disabled={!owner} />
            <Input label="Sender (From)" value={studio.from} placeholder="Studio <hello@studio.com>" onChange={(e) => setStudio({ ...studio, from: e.target.value })} disabled={!owner} />
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
        <Card title="Email" action={<Pill tone={s.email.configured ? 'green' : 'red'}>{s.email.configured ? s.email.describe : 'Not configured'}</Pill>}>
          <form onSubmit={saveEmail} className="space-y-3">
            <Select label="Transport" value={email.type} onChange={(e) => setEmail({ ...email, type: e.target.value })} disabled={!owner}><option value="smtp">SMTP</option><option value="listmonk">listmonk</option></Select>
            <Input label={email.type === 'smtp' ? 'SMTP URL' : 'listmonk URL'} value={email.url} placeholder={email.type === 'smtp' ? 'smtp://user:pass@host:587' : 'http://listmonk:9000'} onChange={(e) => setEmail({ ...email, url: e.target.value })} disabled={!owner} />
            {email.type === 'listmonk' && <><Input label="API token" value={email.token} onChange={(e) => setEmail({ ...email, token: e.target.value })} disabled={!owner} /><Input label="Template id" type="number" value={email.templateId} onChange={(e) => setEmail({ ...email, templateId: e.target.value })} disabled={!owner} /></>}
            <Input label="From address" value={email.from} placeholder="Studio <hello@studio.com>" onChange={(e) => setEmail({ ...email, from: e.target.value })} disabled={!owner} />
            <div className="flex flex-wrap gap-2">{owner && <Button>Save transport</Button>}<Button type="button" kind="secondary" onClick={() => void run(() => api('/api/settings/email/test', { method: 'POST' }), 'Test queued')}>Send test email</Button></div>
          </form>
          {lt && <p className="mt-3 text-sm" data-testid="email-test">Last test: <Pill tone={lt.state === 'done' ? 'green' : lt.state === 'failed' || lt.state === 'needs_review' ? 'red' : 'amber'}>{lt.state}</Pill> {ago(lt.at)} ago{lt.lastError && <span className="block text-red-600">{lt.lastError}</span>}</p>}
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
        <Card title="Issues">
          {issues.length === 0 ? <Empty>No file issues.</Empty> : issues.map((i, k) => (
            <Row key={k}><div className="min-w-0 flex-1"><p>{i.kind.replace('_', ' ')}</p><p className="truncate text-sm text-neutral-500">{i.path}{i.detail ? ` · ${i.detail}` : ''}</p></div>
              {i.kind === 'transfer_pending' && i.id && <Button kind="secondary" onClick={() => void run(() => api(`/api/projects/${i.id}/approve-transfer`, { method: 'POST' }), 'Transfer approved')}>Approve</Button>}
              {i.kind === 'duplicate_id' && <Button kind="secondary" onClick={() => void run(() => api('/api/issues/adopt', { method: 'POST', body: JSON.stringify({ path: i.path }) }), 'Adopted as new')}>Adopt as new</Button>}</Row>))}
        </Card>
        <Card title="Coming later">{LATER.map(([n, m]) => <Row key={n}><span className="flex-1 text-neutral-400">{n}</span><span className="text-xs text-neutral-400">{m}</span></Row>)}</Card>
      </div>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </Shell>);
}
