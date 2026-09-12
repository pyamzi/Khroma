import { defineConfig, devices } from 'playwright/test';
export default defineConfig({
  testDir: 'tests/e2e', testMatch: '**/*.spec.ts', timeout: 60_000, reporter: 'list', retries: process.env.CI ? 1 : 0,
  // iPhone viewport and UA in Chromium (CI installs Chromium only); hasTouch off so the mouse drives the drawing gesture.
  // Touch drawing and real Safari are verified by hand on a phone (docs/gates/m2-culling.md).
  use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', hasTouch: false },
});
