import type { NextConfig } from 'next'

/**
 * Next.js config for Access0x1 checkout-web.
 *
 * - `transpilePackages` covers the Dynamic SDK packages, which ship modern ESM
 *   that Next's default transform leaves alone.
 * - `serverExternalPackages` keeps the Anthropic SDK out of the client bundle;
 *   the Claude API key is server-only (doctrine guardrail #8).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The repo root has a Foundry package-lock.json; pin tracing to this app dir
  // so Next does not infer the monorepo root as the workspace.
  outputFileTracingRoot: __dirname,
  serverExternalPackages: ['@anthropic-ai/sdk'],
  transpilePackages: [
    '@dynamic-labs/sdk-react-core',
    '@dynamic-labs/ethereum',
    '@dynamic-labs/wagmi-connector',
  ],
}

export default nextConfig
