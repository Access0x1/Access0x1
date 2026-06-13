import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the Access0x1 Snap unit tests.
 *
 * The Snap runtime (`snap.request`, `ethereum`) is not available under Node,
 * so tests mock the MetaMask provider. Pure logic (calldata decoding, USD
 * formatting, panel structure) is tested directly.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    globals: false,
  },
});
