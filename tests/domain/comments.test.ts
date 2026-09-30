import { describe, it, expect } from 'vitest';
import { clients, projects, photos, events } from '../../src/server/db/schema.js';
import { addComment, listComments, resolveComment, commentsAllowed, commentCounts, CommentError } from '../../src/server/domain/comments.js';
import { defaultProjectMeta } from '../../src/server/domain/meta.js';
import { studioTestDb } from '../helpers.js';

async function seed(toggles = { culling: true, finals: true }) {
  const { db } = await studioTestDb();
  const meta = defaultProjectMeta('W'); meta.comments = toggles;
  await db.insert(clients).values({ id: 'c1', name: 'A', emails: ['s@x'] });
  await db.insert(projects).values({ id: 'p1', clientId: 'c1', productionState: 'culling', metadataJson: meta as Record<string, unknown> });
  await db.insert(photos).values([
    { id: 'a', projectId: 'p1', relPath: 'raw/a.dng', stage: 'culling', kind: 'photo', checksum: 'a' },
    { id: 'v', projectId: 'p1', relPath: 'raw/v.mp4', stage: 'culling', kind: 'video', checksum: 'v' },
    { id: 'f', projectId: 'p1', relPath: 'finals/f.jpg', stage: 'final', kind: 'photo', checksum: 'f' },
  ]);
  return db;
}

describe('comments', () => {
  it('adds a region comment on a photo and a timestamp comment on a video', async () => {
    const db = await seed();
    const c = await addComment(db, { photoId: 'a', author: 'S@x', isAdmin: false, input: { text: '  soften the shadow ', x: 0.1, y: 0.2, w: 0.3, h: 0.3 } });
    expect(c).toMatchObject({ photoId: 'a', stage: 'culling', author: 's@x', text: 'soften the shadow', x: 0.1, t: null, resolvedAt: null });
    const v = await addComment(db, { photoId: 'v', author: 's@x', isAdmin: false, input: { text: 'cut here', t: 42.5 } });
    expect(v).toMatchObject({ t: 42.5, x: null });
    expect(await listComments(db, 'a')).toHaveLength(1);
    expect((await db.select().from(events)).filter((e) => e.type === 'commented')).toHaveLength(2);
  });
  it('validates text, region bounds, and region-vs-timestamp by kind', async () => {
    const db = await seed();
    const bad = (input: Parameters<typeof addComment>[1]['input'], photoId = 'a') => expect(addComment(db, { photoId, author: 's@x', isAdmin: false, input })).rejects.toThrow(CommentError);
    await bad({ text: '   ' }); await bad({ text: 'x'.repeat(2001) });
    await bad({ text: 'ok', x: 0.9, y: 0, w: 0.2, h: 0.1 });          // x+w > 1
    await bad({ text: 'ok', x: 0, y: 0, w: 0, h: 0.1 });              // w = 0
    await bad({ text: 'ok', x: 0.1, y: 0.1 });                        // partial region
    await bad({ text: 'ok', t: 3 });                                  // timestamp on a photo
    await bad({ text: 'ok', x: 0, y: 0, w: 0.5, h: 0.5 }, 'v');       // region on a video
    await bad({ text: 'ok', t: -1 }, 'v');
    await bad({ text: 'ok' }, 'nope');
    expect((await addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'whole photo' } })).x).toBeNull();
  });
  it('respects the per-stage toggle for clients but not admins', async () => {
    const db = await seed({ culling: false, finals: true });
    expect(await commentsAllowed(db, 'p1', 'culling')).toBe(false); expect(await commentsAllowed(db, 'p1', 'final')).toBe(true);
    await expect(addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'hi' } })).rejects.toThrow(/disabled/);
    expect((await addComment(db, { photoId: 'a', author: 'owner@x', isAdmin: true, input: { text: 'hi' } })).author).toBe('owner@x');
    expect((await addComment(db, { photoId: 'f', author: 's@x', isAdmin: false, input: { text: 'final ok' } })).stage).toBe('final');
  });
  it('resolves and unresolves, and counts open vs total per photo', async () => {
    const db = await seed();
    const c1 = await addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'one' } });
    await addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'two' } });
    expect((await resolveComment(db, { commentId: c1.id, actor: 'owner@x', resolved: true })).resolvedAt).not.toBeNull();
    expect(await commentCounts(db, 'p1')).toEqual({ a: { open: 1, total: 2 } });
    expect((await resolveComment(db, { commentId: c1.id, actor: 'owner@x', resolved: false })).resolvedAt).toBeNull();
    expect((await db.select().from(events)).filter((e) => e.type === 'comment_resolved')).toHaveLength(2);
  });
});
