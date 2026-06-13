import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the Access0x1 web app unit tests.
 *
 * The Walrus host tests are fully OFFLINE — they inject a fetch stub, so no
 * Sui node, publisher, or network is needed. Pure logic (url/encode/parse) is
 * tested directly.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    globals: false,
  },
});
