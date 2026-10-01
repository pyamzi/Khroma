import { test, expect } from 'playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startTestServer, linkIn } from './server.js';

let srv: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => { srv = await startTestServer(); });
test.afterAll(async () => { await srv.stop(); });
test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, userAgent: undefined });

test('a new photographer signs up and lands on their empty dashboard', async ({ page }) => {
  await page.goto(srv.baseUrl + '/signin');
  await page.getByRole('link', { name: 'Create a studio' }).click();
  await page.getByLabel('Studio name').fill('Fresh Studio'); await page.getByLabel('Email').fill('fresh@x.com');
  await page.getByLabel('I am 18 or older').check();
  await page.getByRole('button', { name: 'Create studio' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
  await expect.poll(() => srv.mailbox().filter((m) => m.to === 'fresh@x.com').length).toBe(1);
  await page.goto(linkIn(srv.mailbox().find((m) => m.to === 'fresh@x.com')!.text));
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Nothing waiting. Nice.')).toBeVisible();
  await page.getByRole('button', { name: /Board$/ }).first().click();
  await expect(page.getByTestId('card')).toHaveCount(0); // another Studio's Wedding is not here
});

test('owner runs the studio: dashboard, clients, project detail, settings, board', async ({ page }) => {
  await page.goto(await srv.signInLink('owner@x.com'));
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Nothing waiting. Nice.')).toBeVisible();
  await expect(page.getByText('Invoicing arrives with milestone 7.')).toBeVisible();

  // Clients: create one and a project with the studio defaults
  await page.getByRole('button', { name: 'Clients' }).first().click();
  await page.getByRole('button', { name: 'New client' }).click();
  await page.getByLabel('Name').fill('Jones'); await page.getByLabel('Emails (comma separated)').fill('j@x.com');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Jones' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Title').fill('Headshots'); await page.getByLabel('Included picks (blank = default)').fill('10');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Headshots' })).toBeVisible();
  await expect(page.getByText('0 of 10 picked')).toBeVisible();

  // Project details: rename via the form
  await page.getByRole('tab', { name: 'Details' }).click();
  await page.getByLabel('Title').fill('Headshots 2026');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Headshots 2026' })).toBeVisible();

  // Seeded Wedding project: three culling tiles; a comment posted via the API can be resolved in the viewer
  await page.goto(`${srv.baseUrl}/admin/projects/${srv.projectId}`);
  await expect(page.getByTestId('admin-tile')).toHaveCount(3);
  const first = await page.evaluate(async (id) => { const ph = await (await fetch(`/api/projects/${id}/photos?stage=culling`, { headers: { 'x-requested-with': 'fetch' } })).json(); const r = await fetch(`/api/photos/${ph[0].id}/comments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ text: 'brighten', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }) }); return r.status; }, srv.projectId);
  expect(first).toBe(201);
  await page.reload();
  await page.getByTestId('admin-tile').first().getByRole('button', { name: 'Open photo' }).click();
  await page.getByRole('button', { name: 'Comment 1' }).click();
  await page.getByRole('button', { name: 'Resolve' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('resolved a comment')).toBeVisible();

  // Settings: invite a member
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByLabel('Invite by email').fill('sam@x.com');
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByText('sam@x.com')).toBeVisible();

  // Board: the Wedding card sits in the Culling column
  await page.getByRole('button', { name: /Board$/ }).first().click();
  await expect(page.getByTestId('card').filter({ hasText: 'Wedding' })).toBeVisible();
});

test('owner uploads a photo to the Library and sees it ready', async ({ page }) => {
  const file = join(mkdtempSync(join(tmpdir(), 'lib-')), 'beach.jpg');
  await sharp({ create: { width: 900, height: 600, channels: 3, background: '#39c' } }).jpeg().toFile(file);
  await page.goto(await srv.signInLink('owner@x.com'));
  await page.getByRole('button', { name: 'Library' }).first().click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  await expect(page.getByText('0 photos')).toBeVisible();
  await page.getByTestId('library-input').setInputFiles(file);
  await expect(page.getByText('1 photo', { exact: true })).toBeVisible();
  const thumb = page.getByTestId('library-tile').locator('img');
  await expect(thumb).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await page.getByTestId('library-input').setInputFiles({ name: 'clip.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await expect(page.getByText('clip.gif: not a supported photo type')).toBeVisible();
});

const jpeg = async (name: string) => { const f = join(mkdtempSync(join(tmpdir(), 'lib-')), name); await sharp({ create: { width: 200, height: 100, channels: 3, background: '#c63' } }).jpeg().toFile(f); return f; };

test('a failed upload leaves no tile and no count, and says so', async ({ page }) => {
  await page.goto(await srv.signInLink('owner@x.com'));
  await page.goto(`${srv.baseUrl}/admin/library`);
  await expect(page.getByText(/^\d+ photos?$/)).toBeVisible();
  const before = await page.evaluate(async () => (await (await fetch('/api/library?limit=1', { headers: { 'x-requested-with': 'fetch' } })).json()).total);
  await page.route('**/dev/storage/**', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 403 }) : r.continue()));
  await page.getByTestId('library-input').setInputFiles(await jpeg('bad.jpg'));
  await expect(page.getByRole('alert')).toHaveText(/bad\.jpg: Couldn't upload this file/);
  await expect(page.getByTestId('library-pending')).toHaveCount(0);
  const total = () => page.evaluate(async () => (await (await fetch('/api/library?limit=1', { headers: { 'x-requested-with': 'fetch' } })).json()).total);
  await expect.poll(total).toBe(before); // the half-made row is gone
  await expect(page.getByText(`${before} photo`)).toBeVisible();
});

test('a drop larger than the page shows no false failures', async ({ page }) => {
  await page.goto(await srv.signInLink('owner@x.com'));
  await page.goto(`${srv.baseUrl}/admin/library?pageSize=2`); // a window smaller than the drop: the old ones leave it while still processing
  await expect(page.getByText(/^\d+ photos?$/)).toBeVisible();
  const files = await Promise.all(['a', 'b', 'c', 'd'].map((n) => jpeg(`${n}.jpg`)));
  const readyCount = () => page.evaluate(async () => (await (await fetch('/api/library?limit=200', { headers: { 'x-requested-with': 'fetch' } })).json()).items.filter((i: { status: string }) => i.status === 'ready').length);
  const was = await readyCount();
  await page.getByTestId('library-input').setInputFiles(files);
  await expect.poll(readyCount, { timeout: 30_000 }).toBe(was + 4);
  await page.waitForTimeout(2500); // one more poll cycle
  await expect(page.getByRole('alert')).toHaveCount(0);
});
