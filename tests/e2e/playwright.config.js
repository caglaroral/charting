// E2E tests for the charting app. See docs/TESTING.md.
//   E2E_BASE_URL   (default http://localhost:8080)
//   E2E_ADMIN_USER / E2E_ADMIN_PASS  admin credentials used to create throw-away test users
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // tests share the exchange rate limit and a single backend; keep them serial
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './global-setup.js',
  globalTeardown: './global-teardown.js',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8080',
    viewport: { width: 1600, height: 950 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 950 } } }],
});
