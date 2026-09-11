import { describe, it, expect } from 'vitest';
import { mkdir, rename, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, photos } from '../../src/server/db/schema.js';
import { rescan, approveTransfer } from '../../src/server/fs/index.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';

async function seed(root: string) {
  const c = defaultClientJson('Smith'); const p = defaultProjectJson('Wedding');
  await mkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), c);
  await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), p);
  return { c, p };
}
function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

describe('rescan', () => {
  it('indexes a client and project by id', async () => {
    const root = await tmpDir(); const db = fresh(); const { c, p } = await seed(root);
    const r = await rescan(db, root);
    expect(r.clients).toBe(1); expect(r.projects).toBe(1); expect(r.issues).toEqual([]);
    expect(db.select().from(projects).where(eq(projects.id, p.id!)).get()?.folderPath).toBe('Clients/Smith/Wedding');
    expect(db.select().from(clients).where(eq(clients.id, c.id!)).get()?.folderPath).toBe('Clients/Smith');
  });
  it('assigns an id to a hand-dropped file and writes it back', async () => {
    const root = await tmpDir(); const db = fresh();
    await mkdir(join(root, 'Clients/Jones/Shoot'), { recursive: true });
    await writeFile(join(root, 'Clients/Jones/client.json'), JSON.stringify({ schemaVersion: 1, name: 'Jones' }));
    await writeFile(join(root, 'Clients/Jones/Shoot/project.json'), JSON.stringify({ schemaVersion: 1, title: 'Shoot' }));
    await rescan(db, root);
    const back = JSON.parse(await readFile(join(root, 'Clients/Jones/Shoot/project.json'), 'utf8'));
    expect(back.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.select().from(projects).all()[0]?.id).toBe(back.id);
  });
  it('keeps identity and child rows across a rename made while stopped', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await rescan(db, root);
    db.insert(photos).values({ id: 'ph1', projectId: p.id!, relPath: 'raw/a.nef', stage: 'culling', kind: 'photo', checksum: 'x' }).run();
    await rename(join(root, 'Clients/Smith'), join(root, 'Clients/Smith Family'));
    await rename(join(root, 'Clients/Smith Family/Wedding'), join(root, 'Clients/Smith Family/Wedding 2026'));
    const r = await rescan(db, root);
    expect(r.issues).toEqual([]);
    const row = db.select().from(projects).where(eq(projects.id, p.id!)).get()!;
    expect(row.folderPath).toBe('Clients/Smith Family/Wedding 2026'); expect(row.available).toBe(true);
    expect(db.select().from(photos).where(eq(photos.projectId, p.id!)).all()).toHaveLength(1);
    expect(db.select().from(projects).all()).toHaveLength(1);
  });
  it('marks a missing folder unavailable instead of deleting it, and restores it when it returns', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await rescan(db, root);
    await rename(join(root, 'Clients/Smith/Wedding'), join(root, 'elsewhere'));
    let r = await rescan(db, root);
    expect(r.issues.map((i) => i.kind)).toContain('missing');
    expect(db.select().from(projects).where(eq(projects.id, p.id!)).get()?.available).toBe(false);
    await rename(join(root, 'elsewhere'), join(root, 'Clients/Smith/Wedding'));
    r = await rescan(db, root);
    expect(r.issues).toEqual([]);
    expect(db.select().from(projects).where(eq(projects.id, p.id!)).get()?.available).toBe(true);
    await rm(join(root, 'Clients/Smith'), { recursive: true });
    r = await rescan(db, root);
    expect(r.issues.filter((i) => i.kind === 'missing')).toHaveLength(2); // client and project
  });
  it('quarantines duplicate ids', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await rescan(db, root);
    await mkdir(join(root, 'Clients/Smith/Wedding copy'), { recursive: true });
    await writeJsonAtomic(join(root, 'Clients/Smith/Wedding copy/project.json'), p);
    const r = await rescan(db, root);
    expect(r.issues.filter((i) => i.kind === 'duplicate_id')).toHaveLength(2);
    expect(db.select().from(projects).where(eq(projects.id, p.id!)).get()?.available).toBe(false);
    expect(db.select().from(projects).all()).toHaveLength(1);
  });
  it('flags wrong depth and does not index it', async () => {
    const root = await tmpDir(); const db = fresh();
    await mkdir(join(root, 'Clients/Loose'), { recursive: true });
    await writeJsonAtomic(join(root, 'Clients/Loose/project.json'), defaultProjectJson('Loose'));
    const r = await rescan(db, root);
    expect(r.issues[0]?.kind).toBe('wrong_depth');
    expect(db.select().from(projects).all()).toHaveLength(0);
  });
  it('holds a cross-client move until approved', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await mkdir(join(root, 'Clients/Other'), { recursive: true });
    await writeJsonAtomic(join(root, 'Clients/Other/client.json'), defaultClientJson('Other'));
    await rescan(db, root);
    await rename(join(root, 'Clients/Smith/Wedding'), join(root, 'Clients/Other/Wedding'));
    const r = await rescan(db, root);
    expect(r.issues.map((i) => i.kind)).toContain('transfer_pending');
    let row = db.select().from(projects).where(eq(projects.id, p.id!)).get()!;
    expect(row.available).toBe(false); expect(row.transferPending).toBe(true);
    await rescan(db, root); // a second scan keeps it pending, does not flip-flop
    row = db.select().from(projects).where(eq(projects.id, p.id!)).get()!;
    expect(row.transferPending).toBe(true);
    await approveTransfer(db, root, p.id!, 'owner@x');
    row = db.select().from(projects).where(eq(projects.id, p.id!)).get()!;
    expect(row.available).toBe(true); expect(row.transferPending).toBe(false);
    expect(db.select().from(clients).where(eq(clients.id, row.clientId)).get()?.name).toBe('Other');
    expect((await rescan(db, root)).issues).toEqual([]);
  });
  it('restores an externally edited machine field and reports it', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await rescan(db, root);
    const file = join(root, 'Clients/Smith/Wedding/project.json');
    const edited = { ...p, allowance: { included: 999, extraPrice: 0, slots: 999 }, title: 'Renamed by hand' };
    await writeJsonAtomic(file, edited);
    const r = await rescan(db, root);
    expect(r.issues.map((i) => i.kind)).toContain('machine_field_edited');
    const back = JSON.parse(await readFile(file, 'utf8'));
    expect(back.allowance.included).toBe(0);      // restored from db
    expect(back.title).toBe('Renamed by hand');    // human field kept
    expect(db.select().from(projects).where(eq(projects.id, p.id!)).get()?.metadataJson).toMatchObject({ title: 'Renamed by hand' });
  });
  it('keeps the last good state for malformed json', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await rescan(db, root);
    await writeFile(join(root, 'Clients/Smith/Wedding/project.json'), '{ broken');
    const r = await rescan(db, root);
    expect(r.issues.map((i) => i.kind)).toContain('malformed');
    const row = db.select().from(projects).where(eq(projects.id, p.id!)).get()!;
    expect(row.available).toBe(true);
    expect((row.metadataJson as { title: string }).title).toBe('Wedding');
  });
});
