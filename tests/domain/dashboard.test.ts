import { describe, it, expect } from 'vitest';
import { clients, projects, photos, comments, events, jobs } from '../../src/server/db/schema.js';
import { dashboard } from '../../src/server/domain/dashboard.js';
import { defaultProjectMeta } from '../../src/server/domain/meta.js';
import { studioTestDb } from '../helpers.js';

const NOW = Date.parse('2026-06-10T12:00:00Z'); const ago = (d: number) => new Date(NOW - d * 864e5).toISOString();

describe('dashboard', () => {
  it('derives the four blocks', async () => {
    const { db } = await studioTestDb();
    await db.insert(clients).values({ id: 'c1', name: 'Smith', emails: [] });
    const mk = (id: string, title: string, production: string, date: string | null) =>
      db.insert(projects).values({ id, clientId: 'c1', productionState: production, date, currentRound: production === 'editing' ? 2 : 1, metadataJson: defaultProjectMeta(title) as Record<string, unknown> });
    await mk('p1', 'Editing one', 'editing', null); await mk('p2', 'Idle culling', 'culling', ago(-5).slice(0, 10)); await mk('p3', 'Active culling', 'culling', ago(-20).slice(0, 10)); await mk('p4', 'Old shoot', 'not_started', ago(3).slice(0, 10));
    await db.insert(photos).values([{ id: 'a', projectId: 'p1', relPath: 'raw/a.dng', stage: 'culling', kind: 'photo', checksum: 'a' }, { id: 'd', projectId: 'p1', relPath: 'finals/d.jpg', draftRelPath: 'finals/.draft/d.jpg', stage: 'final', kind: 'photo', checksum: 'd' }]);
    await db.insert(comments).values([{ id: 'c1', photoId: 'a', author: 's', stage: 'culling', text: 'x' }, { id: 'c2', photoId: 'a', author: 's', stage: 'culling', text: 'y', resolvedAt: ago(1) }]);
    await db.insert(events).values([
      { projectId: 'p1', actor: 's', type: 'finished_culling', payload: { photoIds: ['a', 'b', 'c'] }, at: ago(2) },
      { projectId: 'p2', actor: 'system', type: 'production_changed', payload: { to: 'culling' }, at: ago(10) }, { projectId: 'p2', actor: 's', type: 'picked', payload: {}, at: ago(4) },
      { projectId: 'p3', actor: 'system', type: 'production_changed', payload: { to: 'culling' }, at: ago(10) }, { projectId: 'p3', actor: 's', type: 'viewed', payload: {}, at: ago(0.5) },
      { projectId: 'p3', actor: 'system', type: 'preview_failed', payload: {}, at: ago(1) },
    ]);
    await db.insert(jobs).values({ id: 'j1', kind: 'x', payload: {}, nextAt: 0, state: 'needs_review', lastError: 'ambiguous' });
    const d = await dashboard(db, NOW);
    expect(d.waitingOnYou.map((i) => [i.projectId, i.reason, i.count ?? null])).toEqual(expect.arrayContaining([
      ['p1', 'culling_finished', 3], ['p1', 'unresolved_comments', 1], ['p1', 'drafts', 1], ['p3', 'preview_failed', 1], ['', 'review_jobs', 1],
    ]));
    expect(d.waitingOnYou.some((i) => i.reason === 'issues')).toBe(false);
    expect(d.waitingOnClient).toEqual([expect.objectContaining({ projectId: 'p2', reason: 'culling_idle', since: ago(4) })]);
    expect(d.upcoming.map((u) => u.projectId)).toEqual(['p2', 'p3']);
    expect(d.money).toEqual([]);
  });
});
