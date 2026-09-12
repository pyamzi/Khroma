import { test, expect } from 'playwright/test';
import { startTestServer } from './server.js';

let srv: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => { srv = await startTestServer(); });
test.afterAll(async () => { await srv.stop(); });
test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, userAgent: undefined });

test('owner runs the studio: dashboard, clients, files, project detail, settings, board', async ({ page }) => {
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

  // Files: inside the new project, folder, upload, trash, restore
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: 'Open folder' }).click();
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();
  page.once('dialog', (d) => d.accept('Inspiration'));
  await page.getByRole('button', { name: 'New folder' }).click();
  await expect(page.getByText('Inspiration')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'moodboard.txt', mimeType: 'text/plain', buffer: Buffer.from('warm tones') });
  await expect(page.getByText('moodboard.txt')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for moodboard.txt' }).click();
  await page.getByRole('button', { name: 'Move to Trash' }).click();
  await expect(page.getByText('moodboard.txt')).toHaveCount(0);
  await page.getByRole('button', { name: 'Trash' }).click();
  await expect(page.getByText(/moodboard\.txt/)).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Restored')).toBeVisible();

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

  // Settings: invite a member, send a delivery test (memory transport → done)
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByLabel('Invite by email').fill('sam@x.com');
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByText('sam@x.com')).toBeVisible();
  await page.getByRole('button', { name: 'Send test email' }).click();
  await expect(page.getByTestId('email-test')).toContainText('done', { timeout: 10_000 });

  // Board: the Wedding card sits in the Culling column
  await page.getByRole('button', { name: 'Files' }).first().click();
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByTestId('card').filter({ hasText: 'Wedding' })).toBeVisible();
});
