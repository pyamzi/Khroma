import { test, expect } from 'playwright/test';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { withStudio } from '../../src/server/db/tenancy.js';
import { projects } from '../../src/server/db/schema.js';
import { uploadFinal } from '../../src/server/domain/finals.js';
import { startTestServer } from './server.js';

let srv: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => { srv = await startTestServer(); });
test.afterAll(async () => { await srv.stop(); });

test('owner publishes a final; the client hearts it, filters favorites, and downloads it and a ZIP', async ({ page }) => {
  // the owner's Lightroom export: one draft final, rendered by the worker, then published over the API
  const bytes = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#c33' } }).jpeg().toBuffer();
  const { photoId } = await withStudio(srv.db, srv.studioId, async (tx) => {
    await tx.update(projects).set({ productionState: 'editing' }).where(eq(projects.id, srv.projectId));
    return uploadFinal(tx, srv.storage, { projectId: srv.projectId, name: 'A.jpg', bytes, uploadId: 'e2e-1', actor: 'plugin' });
  });
  await expect.poll(() => srv.storage.exists(`s/${srv.studioId}/p/${photoId}/thumb.draft`)).toBe(true);
  const owner = await srv.signInCookie('owner@x.com');
  const headers = { cookie: owner, 'content-type': 'application/json', 'x-requested-with': 'fetch' };
  const { stateVersion } = await (await fetch(`${srv.baseUrl}/api/projects/${srv.projectId}`, { headers })).json() as { stateVersion: number };
  expect((await fetch(`${srv.baseUrl}/api/projects/${srv.projectId}/publish`, { method: 'POST', headers, body: JSON.stringify({ photoIds: [photoId], expectedVersion: stateVersion }) })).status).toBe(200);

  await page.goto(await srv.signInLink('sarah@x.com'));
  await expect(page.getByText('Your gallery is ready')).toBeVisible();
  await page.getByRole('button', { name: 'Open gallery' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${srv.projectId}/gallery$`));
  const tiles = page.getByTestId('gallery-tile');
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first().locator('img')).toHaveAttribute('src', /size=medium&v=/);

  await page.getByRole('tab', { name: /^Favorites/ }).click();
  await expect(tiles).toHaveCount(0);
  await page.getByRole('tab', { name: /^All/ }).click();
  await tiles.first().getByRole('button', { name: 'Favorite' }).click();
  await page.getByRole('tab', { name: 'Favorites · 1' }).click();
  await expect(tiles).toHaveCount(1);
  await page.reload(); // the heart is saved
  await page.getByRole('tab', { name: 'Favorites · 1' }).click();
  await expect(tiles).toHaveCount(1);

  // one photo from the viewer
  await tiles.first().getByRole('button', { name: 'Open photo' }).click();
  const single = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Download' }).click();
  expect((await single).suggestedFilename()).toBe('A.jpg');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // everything as a ZIP, built by the worker while the page polls
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByText('Single photos save to Photos; the ZIP goes to Files.')).toBeVisible();
  const zip = page.waitForEvent('download', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Download all (1)' }).click();
  expect((await zip).suggestedFilename()).toBe('Wedding.zip');
  await expect(page.getByRole('link', { name: 'Save ZIP' })).toBeVisible();
});
