import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright e2e config for the Access0x1 hosted web app.
 *
 * SCOPE & ISOLATION
 * This drives the two critical browser journeys — merchant onboarding and buyer
 * checkout — against a real Next.js dev server, with the wallet + chain mocked
 * (see e2e/fixtures/wallet.ts: no real keys or funds). It is deliberately
 * SEPARATE from the vitest unit suite: vitest discovers the ".test.ts(x)" glob
 * and runs in node; Playwright owns only the ".spec.ts" files under "e2e/", so
 * the two never collide and `npm test` is unaffected.
 *
 * RUNNING IT (kept out of package.json on purpose — the owner wires the script):
 *   npx playwright test --config web/playwright.config.ts
 * or, from web/:
 *   npx playwright test
 * The suggested package.json script to add later (a one-liner, coordinated here,
 * not edited into package.json by this change):
 *   "e2e": "playwright test"
 * First-time only, install the browser binaries: `npx playwright install chromium`.
 *
 * THE TEST ENV
 * The journeys settle on BASE SEPOLIA (84532): its router/USDC come from static
 * `NEXT_PUBLIC_*_84532` keys we can inject below, and it has a real explorer so
 * the receipt renders a verifiable tx-hash link (the checkout journey asserts
 * it). The addresses here are DUMMY placeholders that match the fixture — they
 * are never deployed to and hold nothing; all chain reads/writes are mocked.
 */

/** The dev-server origin the journeys run against. Override via E2E_BASE_URL. */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100'
const PORT = new URL(BASE_URL).port || '3100'

/**
 * Public env the dev server boots with. These mirror the fixture's constants so
 * the app resolves the same chain/router/USDC the mocks answer for. The Dynamic
 * environment id is a well-formed dummy: the fixture intercepts Dynamic's init
 * traffic, so no live Dynamic project is contacted.
 */
const E2E_PUBLIC_ENV: Record<string, string> = {
  NEXT_PUBLIC_DEFAULT_CHAIN_ID: '84532',
  NEXT_PUBLIC_ROUTER_ADDRESS_84532: '0x3333333333333333333333333333333333333333',
  NEXT_PUBLIC_USDC_ADDRESS_84532: '0x4444444444444444444444444444444444444444',
  NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID: '00000000-0000-0000-0000-0000000000e2',
}

export default defineConfig({
  testDir: './e2e',
  // Own ONLY *.spec.ts — vitest keeps every *.test.ts(x). Zero overlap.
  testMatch: '**/*.spec.ts',
  // Fail fast on a stray `test.only` left in a spec.
  forbidOnly: !!process.env.CI,
  // The mocked journeys are deterministic; a single retry absorbs CI flake.
  retries: process.env.CI ? 1 : 0,
  // The two journeys are independent — run them in parallel locally.
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  // Keep the suite snappy but tolerant of a cold Next compile on first hit.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    // Diagnostics only on failure — cheap green runs, rich red ones.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /**
   * Boot the Next dev server for the run (reusing one already up locally). The
   * `prebuild` codegen scripts are dev-server-independent, so `next dev` alone is
   * enough. We pass the test env inline so a developer's real `.env` is never
   * required (or trusted) for the mocked journeys.
   */
  webServer: {
    command: `next dev --port ${PORT}`,
    url: BASE_URL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: { ...process.env, ...E2E_PUBLIC_ENV } as Record<string, string>,
  },
})
