import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../src/server/db/client.js';
import { invoices, projects, clients, jobs } from '../src/server/db/schema.js';
import { getSetting, setSetting } from '../src/server/db/settings.js';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

describe('database', () => {
  it('enables foreign keys', () => {
    const db = fresh();
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });
  it('allows only one unpaid extras invoice per project', () => {
    const db = fresh();
    db.insert(clients).values({ id: 'c1', folderPath: 'Clients/A', name: 'A', emails: ['a@x'] }).run();
    db.insert(projects).values({ id: 'p1', clientId: 'c1', folderPath: 'Clients/A/P', metadataJson: {} }).run();
    const row = { projectId: 'p1', kind: 'extras' as const, amount: 100, tax: 0, currency: 'usd' };
    db.insert(invoices).values({ id: 'i1', ...row }).run();
    expect(() => db.insert(invoices).values({ id: 'i2', ...row }).run()).toThrow(/UNIQUE/);
    db.insert(invoices).values({ id: 'i3', ...row, paidAt: new Date().toISOString(), paidAmount: 100 }).run();
  });
  it('rejects duplicate job idempotency keys', () => {
    const db = fresh();
    db.insert(jobs).values({ id: 'j1', kind: 'x', payload: {}, idempotencyKey: 'k', nextAt: 0 }).run();
    expect(() => db.insert(jobs).values({ id: 'j2', kind: 'x', payload: {}, idempotencyKey: 'k', nextAt: 0 }).run()).toThrow(/UNIQUE/);
  });
  it('rejects a project whose client does not exist', () => {
    const db = fresh();
    expect(() => db.insert(projects).values({ id: 'p1', clientId: 'ghost', folderPath: 'Clients/X/P', metadataJson: {} }).run()).toThrow(/FOREIGN KEY/);
  });
  it('stores settings', () => {
    const db = fresh();
    setSetting(db, 'studioName', 'Test Studio');
    expect(getSetting(db, 'studioName')).toBe('Test Studio');
    expect(getSetting(db, 'missing')).toBeNull();
  });
});
