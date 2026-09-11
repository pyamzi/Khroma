import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, photos, events } from '../../src/server/db/schema.js';
import { addComment, listComments, resolveComment, commentsAllowed, commentCounts, CommentError } from '../../src/server/domain/comments.js';
import { defaultProjectJson } from '../../src/server/fs/schemas.js';

function seed(toggles = { culling: true, finals: true }) {
  const db = openDb(':memory:'); migrate(db);
  const meta = defaultProjectJson('W'); meta.comments = toggles;
  db.insert(clients).values({ id: 'c1', folderPath: 'Clients/A', name: 'A', emails: ['s@x'] }).run();
  db.insert(projects).values({ id: 'p1', clientId: 'c1', folderPath: 'Clients/A/W', productionState: 'culling', metadataJson: meta as Record<string, unknown> }).run();
  db.insert(photos).values([
    { id: 'a', projectId: 'p1', relPath: 'raw/a.dng', stage: 'culling', kind: 'photo', checksum: 'a' },
    { id: 'v', projectId: 'p1', relPath: 'raw/v.mp4', stage: 'culling', kind: 'video', checksum: 'v' },
    { id: 'f', projectId: 'p1', relPath: 'finals/f.jpg', stage: 'final', kind: 'photo', checksum: 'f' },
  ]).run();
  return db;
}

describe('comments', () => {
  it('adds a region comment on a photo and a timestamp comment on a video', () => {
    const db = seed();
    const c = addComment(db, { photoId: 'a', author: 'S@x', isAdmin: false, input: { text: '  soften the shadow ', x: 0.1, y: 0.2, w: 0.3, h: 0.3 } });
    expect(c).toMatchObject({ photoId: 'a', stage: 'culling', author: 's@x', text: 'soften the shadow', x: 0.1, t: null, resolvedAt: null });
    const v = addComment(db, { photoId: 'v', author: 's@x', isAdmin: false, input: { text: 'cut here', t: 42.5 } });
    expect(v).toMatchObject({ t: 42.5, x: null });
    expect(listComments(db, 'a')).toHaveLength(1);
    expect(db.select().from(events).all().filter((e) => e.type === 'commented')).toHaveLength(2);
  });
  it('validates text, region bounds, and region-vs-timestamp by kind', () => {
    const db = seed();
    const bad = (input: Parameters<typeof addComment>[1]['input'], photoId = 'a') => expect(() => addComment(db, { photoId, author: 's@x', isAdmin: false, input })).toThrow(CommentError);
    bad({ text: '   ' }); bad({ text: 'x'.repeat(2001) });
    bad({ text: 'ok', x: 0.9, y: 0, w: 0.2, h: 0.1 });          // x+w > 1
    bad({ text: 'ok', x: 0, y: 0, w: 0, h: 0.1 });              // w = 0
    bad({ text: 'ok', x: 0.1, y: 0.1 });                        // partial region
    bad({ text: 'ok', t: 3 });                                  // timestamp on a photo
    bad({ text: 'ok', x: 0, y: 0, w: 0.5, h: 0.5 }, 'v');       // region on a video
    bad({ text: 'ok', t: -1 }, 'v');
    bad({ text: 'ok' }, 'nope');
    expect(addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'whole photo' } }).x).toBeNull();
  });
  it('respects the per-stage toggle for clients but not admins', () => {
    const db = seed({ culling: false, finals: true });
    expect(commentsAllowed(db, 'p1', 'culling')).toBe(false); expect(commentsAllowed(db, 'p1', 'final')).toBe(true);
    expect(() => addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'hi' } })).toThrow(/disabled/);
    expect(addComment(db, { photoId: 'a', author: 'owner@x', isAdmin: true, input: { text: 'hi' } }).author).toBe('owner@x');
    expect(addComment(db, { photoId: 'f', author: 's@x', isAdmin: false, input: { text: 'final ok' } }).stage).toBe('final');
  });
  it('resolves and unresolves, and counts open vs total per photo', () => {
    const db = seed();
    const c1 = addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'one' } });
    addComment(db, { photoId: 'a', author: 's@x', isAdmin: false, input: { text: 'two' } });
    expect(resolveComment(db, { commentId: c1.id, actor: 'owner@x', resolved: true }).resolvedAt).not.toBeNull();
    expect(commentCounts(db, 'p1')).toEqual({ a: { open: 1, total: 2 } });
    expect(resolveComment(db, { commentId: c1.id, actor: 'owner@x', resolved: false }).resolvedAt).toBeNull();
    expect(db.select().from(events).all().filter((e) => e.type === 'comment_resolved')).toHaveLength(2);
  });
});
