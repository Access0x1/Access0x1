import type { NextConfig } from 'next'

/**
 * Next.js config for the Access0x1 web app.
 *
 * - `transpilePackages` covers the Dynamic SDK packages, which ship modern ESM
 *   that Next's default transform leaves alone.
 * - `serverExternalPackages` keeps the Anthropic SDK out of the client bundle;
 *   the Claude API key is server-only (doctrine guardrail #8).
 * - `webpack.externals` marks the proprietary `@unlink-xyz/sdk` as a SERVER
 *   external. The package ships only as a local type shim here
 *   (types/unlink-sdk.d.ts) and is installed at the booth; without the external,
 *   webpack tries to bundle/resolve it and `next build` HARD-FAILS with "Module
 *   not found". As an external, webpack emits a runtime `require`, so the build
 *   succeeds and the only consumer — the guarded `lib/unlink/loadSdk.ts` loader —
 *   fails soft (UnlinkSdkUnavailableError) at request time when it is absent.
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
  serverExternalPackages: ['@anthropic-ai/sdk'],
  transpilePackages: [
    '@dynamic-labs/sdk-react-core',
    '@dynamic-labs/ethereum',
    '@dynamic-labs/wagmi-connector',
  ],
  webpack: (config, { isServer }) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }
    // The proprietary `@unlink-xyz/sdk` is installed only at the booth. On the
    // server, treat it as an external commonjs require so webpack does not try to
    // bundle/resolve it at build time; the guarded `loadSdk.ts` loader catches a
    // missing package at runtime and fails soft (the private payout leg is
    // server-only, so this never affects the client bundle).
    if (isServer) {
      const externals = config.externals
      const unlinkExternal = { '@unlink-xyz/sdk': 'commonjs @unlink-xyz/sdk' }
      config.externals = Array.isArray(externals)
        ? [...externals, unlinkExternal]
        : [externals, unlinkExternal].filter(Boolean)
    }
    return config
  },
}

export default nextConfig
