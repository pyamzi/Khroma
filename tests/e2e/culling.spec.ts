import { test, expect } from 'playwright/test';
import { startTestServer } from './server.js';

let srv: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => { srv = await startTestServer(); });
test.afterAll(async () => { await srv.stop(); });

test('client signs in, culls with a shared allowance, requests extras, comments, and finishes', async ({ page }) => {
  await page.goto(srv.baseUrl + '/');
  await page.getByPlaceholder('you@example.com').fill('sarah@x.com');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByText(/sign-in link is on its way/)).toBeVisible();
  await expect.poll(() => srv.mailbox().length).toBe(1);
  const link = srv.mailbox()[0]!.text.match(/http:\/\/127\.0\.0\.1:\d+\/auth\/[A-Za-z0-9_-]+/)![0];
  await page.goto(link);
  // one project → lands on its home
  await expect(page.getByRole('heading', { name: 'Wedding' })).toBeVisible();
  await expect(page.getByText('Pick your favorites · 0 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Start picking' }).click();
  const tiles = page.getByTestId('tile');
  await expect(tiles).toHaveCount(3);
  await tiles.nth(0).getByRole('button', { name: 'Pick' }).click();
  await tiles.nth(1).getByRole('button', { name: 'Pick' }).click();
  await expect(page.getByTestId('count')).toHaveText('2 of 2');
  await tiles.nth(2).getByRole('button', { name: 'Pick' }).click();
  await expect(page.getByText('1 extra photo · $15')).toBeVisible();
  await page.getByRole('button', { name: 'Request' }).click();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Request sent.')).toBeVisible();
  await page.getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => srv.mailbox().some((m) => m.subject.includes('1 extra photos'))).toBe(true);
  // unpick the extra, open the viewer, draw a region, comment, finish
  await tiles.nth(2).getByRole('button', { name: 'Unpick' }).click();
  await expect(page.getByTestId('count')).toHaveText('2 of 2');
  await tiles.nth(0).getByRole('button', { name: 'Open photo' }).click();
  await expect(page.getByText('1 / 3')).toBeVisible();
  const img = page.locator('img[src$="/preview"]'); await expect(img).toBeVisible();
  const box = (await img.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 }); await page.mouse.up();
  await page.getByTestId('comment-input').fill('soften the shadow');
  await page.getByRole('button', { name: 'Post' }).click();
  await expect(page.getByRole('button', { name: 'Comment 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(tiles.nth(0)).toContainText('1');
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('heading', { name: 'Send 2 picks?' })).toBeVisible();
  await page.getByRole('button', { name: 'Send picks' }).click();
  await expect(page.getByText("We're editing · 0 of 2 done")).toBeVisible();
  await expect.poll(() => srv.mailbox().some((m) => m.subject.includes('finished picking'))).toBe(true);
});
