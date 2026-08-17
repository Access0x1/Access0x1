import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vitest 4 transforms with oxc by default, which is `esbuild`'s replacement —
  // `esbuild` config is deprecated (silently ignored, confirmed by a runtime
  // warning) and oxc's own default JSX runtime is already 'automatic' (matches
  // Next.js: components don't import React), so no explicit jsx config is
  // needed here anymore. Kept as a note in case that default ever changes and
  // SSR-rendering a .tsx component starts throwing "React is not defined".
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
    // Integration vectors need live services (mainnet HTTP, a real Postgres);
    // run via `test:integration`. Under vitest 4 a config `exclude` beats any
    // CLI filename filter (a positional path still reports "No test files
    // found"), so the old `vitest run **/*.integration.test.ts` script silently
    // could not run AT ALL — the exclude must be lifted by the script itself,
    // hence the VITEST_INTEGRATION=1 gate: unset (the normal gate) keeps
    // integration tests excluded exactly as before; set, the include flips to
    // integration tests only.
    // e2e/ holds Playwright `.spec.ts` files (run via `playwright test`, never
    // vitest — they call test.describe() from @playwright/test); exclude them so
    // a plain `vitest run` is green on a fresh clone.
    ...(process.env.VITEST_INTEGRATION === '1'
      ? { include: ['**/*.integration.test.ts'] }
      : {}),
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(process.env.VITEST_INTEGRATION === '1' ? [] : ['**/*.integration.test.ts']),
      '**/e2e/**',
    ],
  },
});
