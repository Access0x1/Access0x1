import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Transform JSX/TSX with the automatic runtime (matches Next.js: components
  // don't import React). Without this, esbuild defaults to the classic runtime
  // and SSR-rendering a .tsx component throws "React is not defined".
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: [
      // Mirror the tsconfig `@/*` → `./*` path mapping. Route files import
      // `@/lib/...` with a `.js` extension (NodeNext style); strip it and
      // resolve against the package root so both tsc and vitest agree.
      {
        find: /^@\/(.*)\.js$/,
        replacement: fileURLToPath(new URL('./$1.ts', import.meta.url)),
      },
      {
        find: /^@\/(.*)$/,
        replacement: fileURLToPath(new URL('./$1', import.meta.url)),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    // Auto-discover every unit's tests: __tests__/ (arc + ens),
    // lib/agent/__tests__/ and app/api/agent/__tests__/ (dynamic-agent),
    // and test/ (unlink-private). Do NOT restrict `include` — the default
    // **/*.test.ts(x) glob covers all of them.
    // Integration vectors need live Mainnet HTTP; run via `test:integration`.
    // e2e/ holds Playwright `.spec.ts` files (run via `playwright test`, never
    // vitest — they call test.describe() from @playwright/test); exclude them so
    // a plain `vitest run` is green on a fresh clone.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts', '**/e2e/**'],
  },
});
