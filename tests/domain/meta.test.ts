import { describe, it, expect } from 'vitest';
import { ProjectMeta, defaultProjectMeta } from '../../src/server/domain/meta.js';

describe('project metadata', () => {
  it('defaults', () => {
    const m = defaultProjectMeta('Wedding');
    expect(m.title).toBe('Wedding');
    expect(m.allowance).toEqual({ included: 0, extraPrice: 0 });
    expect(m.folders).toEqual({ culling: 'raw', finals: 'finals' });
    expect(m.downloads).toBe('client');
  });
  it('strips retired and unknown keys', () => {
    const m = ProjectMeta.parse({ title: 'W', sharedFiles: ['a.pdf'], state: { booking: 'x' }, allowance: { included: 2, extraPrice: 5, slots: 2 } });
    expect(m).not.toHaveProperty('sharedFiles'); expect(m).not.toHaveProperty('state');
    expect(m.allowance).toEqual({ included: 2, extraPrice: 5 });
  });
  it('rejects a negative allowance and a bad folder name', () => {
    expect(ProjectMeta.safeParse({ title: 'W', allowance: { included: -1, extraPrice: 0 } }).success).toBe(false);
    expect(ProjectMeta.safeParse({ title: 'W', folders: { culling: '../x', finals: 'finals' } }).success).toBe(false);
  });
});
