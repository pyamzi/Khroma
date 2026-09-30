import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { startTestServer } from './server.js';
import { photos } from '../../src/server/db/schema.js';
import { withStudio } from '../../src/server/db/tenancy.js';

describe('e2e harness', () => {
  it('boots with previews ready and an empty mailbox', async () => {
    const srv = await startTestServer();
    try {
      expect(await (await fetch(srv.baseUrl + '/healthz')).json()).toEqual({ ok: true });
      const ph = await withStudio(srv.db, srv.studioId, (tx) => tx.select().from(photos).where(eq(photos.projectId, srv.projectId)));
      expect(ph).toHaveLength(3); expect(ph.every((p) => p.width !== null)).toBe(true);
      expect(srv.mailbox()).toEqual([]);
    } finally { await srv.stop(); }
  });
});
