import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // Mirror the tsconfig `@/*` → `./*` path mapping. The route files import
      // `@/lib/...` with a `.js` extension (NodeNext style); strip it and
      // resolve against the package root so both tsc and vitest agree.
      {
        find: /^@\/(.*)\.js$/,
        replacement: fileURLToPath(new URL("./$1.ts", import.meta.url)),
      },
      {
        find: /^@\/(.*)$/,
        replacement: fileURLToPath(new URL("./$1", import.meta.url)),
      },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
