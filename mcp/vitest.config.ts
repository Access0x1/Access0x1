import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * The package ships as a Node-ESM build: source uses runtime-correct `.js`
 * import specifiers that point at sibling `.ts` files (required by NodeNext at
 * publish time). Vite/Vitest does not resolve those specifiers to `.ts` on its
 * own, so a small `resolveId` shim rewrites relative `./x.js` imports to `./x.ts`
 * during tests only. This keeps ONE import style across source and dist without a
 * separate test tsconfig.
 */
export default defineConfig({
  plugins: [
    {
      name: 'access0x1-mcp-resolve-ts-from-js',
      enforce: 'pre',
      async resolveId(source, importer) {
        const isRelative = source.startsWith('./') || source.startsWith('../');
        if (importer && isRelative && source.endsWith('.js')) {
          const asTs = `${source.slice(0, -3)}.ts`;
          const resolved = await this.resolve(asTs, importer, { skipSelf: true });
          if (resolved) {
            return resolved;
          }
        }
        return null;
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
