import { useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { Shell } from './Shell';
import { Card, Empty, Row, Pill } from './ui';
import { REASON, ago, type Dashboard as D } from './api';

export function Dashboard() {
  const [d, setD] = useState<D | null>(null);
  useEffect(() => { void api<D>('/api/dashboard').then(setD); }, []);
  if (!d) return <Shell section="/admin" title="Dashboard"><Empty>Loading…</Empty></Shell>;
  const go = (i: { projectId: string; reason: string }) => i.projectId ? navigate(`/admin/projects/${i.projectId}`) : navigate(i.reason === 'issues' ? '/admin/files' : '/admin/settings#jobs');
  return (
    <Shell section="/admin" title="Dashboard">
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Waiting on you">
          {d.waitingOnYou.length === 0 ? <Empty>Nothing waiting. Nice.</Empty> : d.waitingOnYou.map((i, k) => (
            <Row key={k} onClick={() => go(i)}><div className="flex-1"><p>{REASON[i.reason] ?? i.reason}</p><p className="text-sm text-neutral-500">{i.title}{i.client ? ` · ${i.client}` : ''}</p></div>{i.count !== undefined && <Pill tone="blue">{i.count}</Pill>}<span className="text-sm text-neutral-400">{ago(i.since)}</span></Row>))}
        </Card>
        <Card title="Waiting on client">
          {d.waitingOnClient.length === 0 ? <Empty>Everyone is on it.</Empty> : d.waitingOnClient.map((i, k) => (
            <Row key={k} onClick={() => go(i)}><div className="flex-1"><p>{REASON[i.reason] ?? i.reason}</p><p className="text-sm text-neutral-500">{i.title} · {i.client}</p></div><span className="text-sm text-neutral-400">{ago(i.since)}</span></Row>))}
        </Card>
        <Card title="Money"><Empty>Invoicing arrives with milestone 7.</Empty></Card>
        <Card title="Upcoming">
          {d.upcoming.length === 0 ? <Empty>No dated shoots ahead.</Empty> : d.upcoming.map((u) => (
            <Row key={u.projectId} onClick={() => navigate(`/admin/projects/${u.projectId}`)}><span className="w-24 text-sm text-neutral-500">{u.date}</span><div className="flex-1"><p>{u.title}</p><p className="text-sm text-neutral-500">{u.client}</p></div></Row>))}
        </Card>
      </div>
    </Shell>);
}
