import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, photos, comments, events, jobs } from '../../src/server/db/schema.js';
import { dashboard } from '../../src/server/domain/dashboard.js';
import { defaultProjectJson } from '../../src/server/fs/schemas.js';

const NOW = Date.parse('2026-06-10T12:00:00Z'); const ago = (d: number) => new Date(NOW - d * 864e5).toISOString();
function fresh() {
  const db = openDb(':memory:'); migrate(db);
  db.insert(clients).values({ id: 'c1', folderPath: 'Clients/A', name: 'Smith', emails: [] }).run();
  const mk = (id: string, title: string, production: string, date: string | null) =>
    db.insert(projects).values({ id, clientId: 'c1', folderPath: `Clients/A/${id}`, productionState: production, date, currentRound: production === 'editing' ? 2 : 1, metadataJson: defaultProjectJson(title) as Record<string, unknown> }).run();
  mk('p1', 'Editing one', 'editing', null); mk('p2', 'Idle culling', 'culling', ago(-5).slice(0, 10)); mk('p3', 'Active culling', 'culling', ago(-20).slice(0, 10)); mk('p4', 'Old shoot', 'not_started', ago(3).slice(0, 10));
  return db;
}

describe('dashboard', () => {
  it('derives the four blocks', () => {
    const db = fresh();
    db.insert(photos).values([{ id: 'a', projectId: 'p1', relPath: 'raw/a.dng', stage: 'culling', kind: 'photo', checksum: 'a' }, { id: 'd', projectId: 'p1', relPath: 'finals/d.jpg', draftRelPath: 'finals/.draft/d.jpg', stage: 'final', kind: 'photo', checksum: 'd' }]).run();
    db.insert(comments).values([{ id: 'c1', photoId: 'a', author: 's', stage: 'culling', text: 'x' }, { id: 'c2', photoId: 'a', author: 's', stage: 'culling', text: 'y', resolvedAt: ago(1) }]).run();
    db.insert(events).values([
      { projectId: 'p1', actor: 's', type: 'finished_culling', payload: { photoIds: ['a', 'b', 'c'] }, at: ago(2) },
      { projectId: 'p2', actor: 'system', type: 'production_changed', payload: { to: 'culling' }, at: ago(10) }, { projectId: 'p2', actor: 's', type: 'picked', payload: {}, at: ago(4) },
      { projectId: 'p3', actor: 'system', type: 'production_changed', payload: { to: 'culling' }, at: ago(10) }, { projectId: 'p3', actor: 's', type: 'viewed', payload: {}, at: ago(0.5) },
      { projectId: 'p3', actor: 'system', type: 'preview_failed', payload: {}, at: ago(1) },
    ]).run();
    db.insert(jobs).values({ id: 'j1', kind: 'x', payload: {}, nextAt: 0, state: 'needs_review', lastError: 'ambiguous' }).run();
    const d = dashboard(db, NOW);
    expect(d.waitingOnYou.map((i) => [i.projectId, i.reason, i.count ?? null])).toEqual(expect.arrayContaining([
      ['p1', 'culling_finished', 3], ['p1', 'unresolved_comments', 1], ['p1', 'drafts', 1], ['p3', 'preview_failed', 1], ['', 'review_jobs', 1],
    ]));
    expect(d.waitingOnClient).toEqual([expect.objectContaining({ projectId: 'p2', reason: 'culling_idle', since: ago(4) })]);
    expect(d.upcoming.map((u) => u.projectId)).toEqual(['p2', 'p3']);
    expect(d.money).toEqual([]);
  });
});
