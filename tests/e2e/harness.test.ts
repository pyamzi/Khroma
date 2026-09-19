import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestServer } from './server.js';
import { jobs, events, photos } from '../../src/server/db/schema.js';

describe('e2e harness', () => {
  it('boots with previews ready, setup complete, and an empty mailbox', async () => {
    const srv = await startTestServer();
    try {
      const js = srv.db.select().from(jobs).all().map((j) => [j.kind, j.state, j.lastError]);
      const evs = srv.db.select().from(events).all().map((e) => [e.type, JSON.stringify(e.payload).slice(0, 300)]);
      const ph = srv.db.select().from(photos).where(eq(photos.projectId, srv.projectId)).all();
      console.log(JSON.stringify({ js, evs, widths: ph.map((p) => p.width) }));
      expect((await (await fetch(srv.baseUrl + '/healthz')).json()).setup).toBe('complete');
      expect(ph.every((p) => p.width !== null)).toBe(true);
      expect(srv.mailbox()).toEqual([]);
    } finally { await srv.stop(); }
  });
});
