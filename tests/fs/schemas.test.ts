import { describe, it, expect } from 'vitest';
import { ProjectJson, ClientJson, defaultProjectJson, defaultClientJson, splitFields, MACHINE_FIELDS } from '../../src/server/fs/schemas.js';

describe('schemas', () => {
  it('defaults are valid and carry ids', () => {
    const p = ProjectJson.parse(defaultProjectJson('Wedding'));
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.folders).toEqual({ culling: 'raw', finals: 'finals' });
    const c = ClientJson.parse(defaultClientJson('Smith'));
    expect(c.emails).toEqual([]);
  });
  it('accepts a file without an id (assigned later)', () => {
    const r = ProjectJson.safeParse({ schemaVersion: 1, title: 'X' });
    expect(r.success).toBe(true);
  });
  it('rejects unknown schema versions', () => {
    expect(ProjectJson.safeParse({ schemaVersion: 9, title: 'X' }).success).toBe(false);
  });
  it('splits human from machine fields', () => {
    const p = ProjectJson.parse(defaultProjectJson('X'));
    const { human, machine } = splitFields(p);
    expect(Object.keys(machine).sort()).toEqual([...MACHINE_FIELDS].sort());
    expect(human).toHaveProperty('title');
    expect(human).not.toHaveProperty('id');
  });
});
