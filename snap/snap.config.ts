import type { SnapConfig } from '@metamask/snaps-cli';

/**
 * MetaMask Snaps CLI build configuration.
 *
 * The bundle entry is `src/index.ts`. `mm-snap build` emits `dist/bundle.js`
 * (webpack is the default and only bundler in the v8 CLI) and writes the real
 * `source.shasum` into `snap.manifest.json`.
 *
 * @see https://docs.metamask.io/snaps/
 */
const config: SnapConfig = {
  input: 'src/index.ts',
  server: {
    port: 8080,
  },
  polyfills: {
    buffer: true,
  },
};

export default config;
