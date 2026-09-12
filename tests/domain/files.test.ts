import { describe, it, expect } from 'vitest';
import { mkdir as fsMkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { makeJpeg } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { projects, photos, events } from '../../src/server/db/schema.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia } from '../../src/server/fs/photos.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';
import { listDir, mkdir, move, trash, restore, listTrash, writeUpload, purgeTrash } from '../../src/server/domain/files.js';

async function seed() {
  const root = await tmpDir(); const db = openDb(':memory:'); migrate(db);
  const c = defaultClientJson('Smith'); const o = defaultClientJson('Other'); const p = defaultProjectJson('Wedding');
  await fsMkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true }); await fsMkdir(join(root, 'Clients/Other'), { recursive: true }); await fsMkdir(join(root, 'Marketing'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), c); await writeJsonAtomic(join(root, 'Clients/Other/client.json'), o);
  await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), p);
  await makeJpeg(join(root, 'Clients/Smith/Wedding/raw/a.jpg')); await writeFile(join(root, 'Marketing/notes.txt'), 'hi');
  await rescan(db, root); await indexProjectMedia(db, root, p.id!);
  return { root, db, pid: p.id!, cid: c.id!, oid: o.id! };
}

describe('files domain', () => {
  it('lists the root with kinds and badges', async () => {
    const { root, db } = await seed();
    const r = await listDir(db, root, '');
    expect(r.entries.map((e) => [e.name, e.kind])).toEqual([['Clients', 'dir'], ['Marketing', 'dir']]);
    const cl = await listDir(db, root, 'Clients');
    expect(cl.entries.find((e) => e.name === 'Smith')).toMatchObject({ kind: 'client', id: expect.any(String) });
    const sm = await listDir(db, root, 'Clients/Smith');
    expect(sm.entries.find((e) => e.name === 'Wedding')).toMatchObject({ kind: 'project', badge: { state: 'culling', available: true } });
    expect(sm.entries.find((e) => e.name === 'client.json')).toBeUndefined();
    const raw = await listDir(db, root, 'Clients/Smith/Wedding/raw');
    expect(raw.entries[0]).toMatchObject({ name: 'a.jpg', kind: 'file', media: 'photo' });
    await expect(listDir(db, root, 'Nope')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('refuses reserved paths and traversal everywhere', async () => {
    const { root, db } = await seed();
    await expect(mkdir(db, root, 'Clients/Smith/Wedding/.cache/x', 'o')).rejects.toMatchObject({ code: 'reserved' });
    await expect(mkdir(db, root, '../x', 'o')).rejects.toThrow();
    await expect(writeUpload(db, root, { dirRel: 'Clients/Smith', name: 'project.json', bytes: Buffer.from('{}'), size: 2, actor: 'o' })).rejects.toMatchObject({ code: 'reserved' });
    await expect(writeUpload(db, root, { dirRel: '.trash', name: 'x.txt', bytes: Buffer.from('x'), size: 1, actor: 'o' })).rejects.toMatchObject({ code: 'reserved' });
    await expect(move(db, root, { from: 'Marketing/notes.txt', to: 'Clients/Smith/Wedding/.draft/notes.txt', actor: 'o' })).rejects.toMatchObject({ code: 'reserved' });
    await expect(trash(db, root, { rel: 'Clients/Smith/client.json', actor: 'o' })).rejects.toMatchObject({ code: 'reserved' });
    await expect(move(db, root, { from: 'Marketing', to: 'Marketing/inner', actor: 'o' })).rejects.toMatchObject({ code: 'invalid' });
  });
  it('mkdir, rename within a client, and a plain file move keep project identity', async () => {
    const { root, db, pid } = await seed();
    expect((await mkdir(db, root, 'Marketing/Instagram', 'o')).kind).toBe('dir');
    await expect(mkdir(db, root, 'Marketing/Instagram', 'o')).rejects.toMatchObject({ code: 'exists' });
    await move(db, root, { from: 'Clients/Smith/Wedding', to: 'Clients/Smith/Wedding 2026', actor: 'o' });
    const row = db.select().from(projects).where(eq(projects.id, pid)).get()!;
    expect(row.folderPath).toBe('Clients/Smith/Wedding 2026'); expect(row.available).toBe(true);
    expect(db.select().from(photos).where(eq(photos.projectId, pid)).all()).toHaveLength(1);
    await move(db, root, { from: 'Marketing/notes.txt', to: 'Clients/Smith/Wedding 2026/notes.txt', actor: 'o' });
    expect((await stat(join(root, 'Clients/Smith/Wedding 2026/notes.txt'))).isFile()).toBe(true);
    await move(db, root, { from: 'Clients/Smith/Wedding 2026/raw/a.jpg', to: 'Clients/Smith/Wedding 2026/raw/z.jpg', actor: 'o' });
    expect(db.select().from(events).all().some((e) => e.type === 'media_renamed_externally')).toBe(true);
  });
  it('a cross-client project move needs confirmation, then transfers with the same id', async () => {
    const { root, db, pid, oid } = await seed();
    await expect(move(db, root, { from: 'Clients/Smith/Wedding', to: 'Clients/Other/Wedding', actor: 'o' })).rejects.toMatchObject({ code: 'needs_confirm' });
    expect((await stat(join(root, 'Clients/Smith/Wedding'))).isDirectory()).toBe(true);
    const r = await move(db, root, { from: 'Clients/Smith/Wedding', to: 'Clients/Other/Wedding', actor: 'o', confirm: true });
    expect(r.transfer).toBe('approved');
    const row = db.select().from(projects).where(eq(projects.id, pid)).get()!;
    expect(row.clientId).toBe(oid); expect(row.available).toBe(true); expect(row.transferPending).toBe(false);
  });
  it('trash keeps rows and ids; restore brings them back; purge removes old entries', async () => {
    const { root, db, pid } = await seed();
    const t = await trash(db, root, { rel: 'Clients/Smith/Wedding', actor: 'o' });
    expect(t.trashRel).toMatch(/^\.trash\//);
    let row = db.select().from(projects).where(eq(projects.id, pid)).get()!;
    expect(row.available).toBe(false);
    expect(db.select().from(photos).where(eq(photos.projectId, pid)).all()).toHaveLength(1);
    const list = await listTrash(root);
    expect(list).toEqual([expect.objectContaining({ trashRel: t.trashRel, original: 'Clients/Smith/Wedding' })]);
    await restore(db, root, { trashRel: t.trashRel, actor: 'o' });
    row = db.select().from(projects).where(eq(projects.id, pid)).get()!;
    expect(row.available).toBe(true); expect(row.folderPath).toBe('Clients/Smith/Wedding');
    await trash(db, root, { rel: 'Marketing/notes.txt', actor: 'o' });
    expect(await purgeTrash(root, 0)).toBe(1);
    expect(await listTrash(root)).toEqual([]);
    expect(db.select().from(events).all().filter((e) => ['trashed', 'restored'].includes(e.type))).toHaveLength(3);
  });
  it('uploads under limits with sanitised names; oversize and executables are refused', async () => {
    const { root, db } = await seed();
    const e = await writeUpload(db, root, { dirRel: 'Marketing', name: '../evil.txt', bytes: Buffer.from('x'), size: 1, actor: 'o' });
    expect(e.name).toBe('evil.txt'); expect((await stat(join(root, 'Marketing/evil.txt'))).size).toBe(1);
    await expect(writeUpload(db, root, { dirRel: 'Marketing', name: 'big.bin', bytes: Buffer.alloc(10), size: 3 * 1024 ** 3, actor: 'o' })).rejects.toMatchObject({ code: 'too_large' });
    await expect(writeUpload(db, root, { dirRel: 'Marketing', name: 'run.sh', bytes: Buffer.from('#!/bin/sh'), size: 9, actor: 'o' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(writeUpload(db, root, { dirRel: 'Marketing', name: 'evil.txt', bytes: Buffer.from('y'), size: 1, actor: 'o' })).rejects.toMatchObject({ code: 'exists' });
    await expect(writeUpload(db, root, { dirRel: 'Nope', name: 'a.txt', bytes: Buffer.from('y'), size: 1, actor: 'o' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await readdir(join(root, 'Marketing'))).filter((n) => n.endsWith('.part'))).toEqual([]);
  });
});
