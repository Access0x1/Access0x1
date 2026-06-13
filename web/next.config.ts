import type { NextConfig } from 'next'

/**
 * Next.js config for the Access0x1 web app.
 *
 * - `transpilePackages` covers the Dynamic SDK packages, which ship modern ESM
 *   that Next's default transform leaves alone.
 * - `serverExternalPackages` keeps the Anthropic SDK out of the client bundle;
 *   the Claude API key is server-only (doctrine guardrail #8).
 * - `webpack.extensionAlias` lets the NodeNext-style `.js` imports authored by
 *   the arc-gasfree and dynamic-agent routes (e.g. `@/lib/arc-constants.js`,
 *   `../../lib/agent/payPerCall.js`) resolve to their `.ts`/`.tsx` sources.
 *   tsc (moduleResolution: bundler) and vitest (config alias) already do this;
 *   this aligns webpack so `next build` agrees with the typecheck and tests.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The repo root has a Foundry package-lock.json; pin tracing to this app dir
  // so Next does not infer the monorepo root as the workspace.
  outputFileTracingRoot: __dirname,
  // `serverExternalPackages` keeps the Anthropic SDK out of the client bundle;
  // the Claude API key is server-only (doctrine guardrail #8).
  //
  // NOTE: the server-only payout route imports the proprietary `@unlink-xyz/sdk`,
  // which ships only as a type shim here (types/unlink-sdk.d.ts) and is installed
  // at the booth. Until that package is present, `next build` (webpack) cannot
  // resolve it -- tsc (type shim) and the vitest suite (mocked) are unaffected.
  serverExternalPackages: ['@anthropic-ai/sdk'],
  transpilePackages: [
    '@dynamic-labs/sdk-react-core',
    '@dynamic-labs/ethereum',
    '@dynamic-labs/wagmi-connector',
  ],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }
    return config
  },
}

export default nextConfig
