import { describe, it, expect } from 'vitest';
import { webhookInbox } from '../../src/server/db/schema.js';
import { asSystem } from '../../src/server/db/tenancy.js';
import { recordWebhook, markApplied } from '../../src/server/jobs/inbox.js';
import { testDb } from '../helpers.js';

describe('webhook inbox', () => {
  it('stores once per provider event id', async () => {
    const db = await testDb();
    await asSystem(db, async (tx) => {
      expect(await recordWebhook(tx, 'stripe', 'evt_1', 'in_1', { a: 1 })).toBe(true);
      expect(await recordWebhook(tx, 'stripe', 'evt_1', 'in_1', { a: 1 })).toBe(false);
      expect(await recordWebhook(tx, 'docuseal', 'evt_1', null, {})).toBe(true);
      await markApplied(tx, 'stripe', 'evt_1');
      expect((await tx.select().from(webhookInbox)).map((r) => r.state).sort()).toEqual(['applied', 'received']);
    });
  });
});
