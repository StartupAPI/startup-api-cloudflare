import { defineConfig, devices } from '@playwright/test';

// Browser tests for the <power-strip> web component (public/users/power-strip.js).
// No server: each test serves a page and the component from disk and mocks the
// /users API with page.route (see test/browser/harness.ts). `*.pw.ts` keeps them
// out of the vitest (workers) suite.
export default defineConfig({
  testDir: 'test/browser',
  testMatch: '*.pw.ts',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
