import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration vectors require live Mainnet HTTP; run them via `test:integration`.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
});
