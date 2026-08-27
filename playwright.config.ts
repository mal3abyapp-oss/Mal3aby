import { defineConfig, devices } from '@playwright/test'

// Phase 4 (Staging + Automated E2E). See E2E_TEST_STRATEGY.md for the
// full rationale, what's covered vs. skipped, and how to run this.
//
// BASE_URL resolution (cheapest-first, matches STAGING_ARCHITECTURE.md):
//   1. E2E_BASE_URL env var, if set -- points at any real deployed
//      target: the workers.dev fallback URL, a future staging
//      environment, or production itself for a read-only smoke pass.
//   2. Otherwise, the local Vite dev server (started automatically by
//      the `webServer` block below) -- this is what a contributor gets
//      by default with zero extra setup, `npm run test:e2e`.
//
// This project has ONE Supabase project (gxkrtlvpjwxhcqdisyob, Free
// tier) -- every target above talks to that SAME real backend. There is
// no mocked/fake API layer anywhere in this suite; "environment" here
// means "which built frontend is serving the page," not "which
// database." See STAGING_ARCHITECTURE.md for why that's the correct,
// zero-new-cost interpretation of "staging" for this project today.
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
const USING_EXTERNAL_TARGET = !!process.env.E2E_BASE_URL

export default defineConfig({
  testDir: './e2e',
  // Fixture-minting and any one-off setup script lives under
  // e2e/setup/ and is run explicitly via `npm run e2e:setup`, not
  // picked up as a spec file.
  testIgnore: ['**/setup/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
  ],

  // Only spin up (and tear down) a local dev server when no external
  // BASE_URL was given -- running against a real deployed target (the
  // workers.dev URL, a future staging host, or production for the
  // public-route smoke subset) must never also boot a second local
  // server pointing at potentially different code.
  webServer: USING_EXTERNAL_TARGET
    ? undefined
    : {
        command: 'npm run dev',
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
})
