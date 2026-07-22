import { defineConfig } from "vitest/config";

/**
 * Vitest config for @access0x1/x402-client. Tests run in the Node environment (the
 * payer targets any JS runtime) and drive the payer with a mocked {@link FetchLike},
 * so no network is touched.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
