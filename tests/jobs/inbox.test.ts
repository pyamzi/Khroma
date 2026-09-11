import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { webhookInbox } from '../../src/server/db/schema.js';
import { recordWebhook, markApplied } from '../../src/server/jobs/inbox.js';

describe('webhook inbox', () => {
  it('stores once per provider event id', () => {
    const db = openDb(':memory:'); migrate(db);
    expect(recordWebhook(db, 'stripe', 'evt_1', 'in_1', { a: 1 })).toBe(true);
    expect(recordWebhook(db, 'stripe', 'evt_1', 'in_1', { a: 1 })).toBe(false);
    expect(recordWebhook(db, 'docuseal', 'evt_1', null, {})).toBe(true);
    markApplied(db, 'stripe', 'evt_1');
    expect(db.select().from(webhookInbox).all().map((r) => r.state).sort()).toEqual(['applied', 'received']);
  });
});
