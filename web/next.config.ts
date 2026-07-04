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
 * - `headers()` applies a baseline of HTTP security headers to EVERY response
 *   (see {@link SECURITY_HEADERS}): a CSP that denies framing + plugins while
 *   still letting the app, the wallet SDKs, and the RPC/auth backends run;
 *   `X-Frame-Options: DENY` (clickjacking belt-and-suspenders for the CSP's
 *   `frame-ancestors 'none'`); `X-Content-Type-Options: nosniff`; HSTS; a
 *   privacy-preserving `Referrer-Policy`; and a locked-down `Permissions-Policy`.
 *   Without these, any surviving XSS (e.g. an SVG-logo CSS beacon) runs with no
 *   CSP backstop and the checkout can be silently iframed (red-report R-3/R-4).
 */

/**
 * Content-Security-Policy applied to every response. This is the "sensible
 * default that lets the app function" rather than a nonce-strict policy:
 *
 *   - `script-src` allows `'unsafe-inline'`/`'unsafe-eval'` because Next.js's
 *     hydration bootstrap and the Dynamic/wagmi wallet SDKs both rely on them
 *     (a nonce-strict policy would blank the app); CSP is here to backstop
 *     injected *markup* (e.g. an SVG `<style>`/`url()` beacon), not to replace
 *     the SVG sanitizer.
 *   - `style-src 'unsafe-inline'` is required by Tailwind/Next inline styles and
 *     the brand-color inline `style={{ background }}` on the checkout card.
 *   - `img-src` allows `data:`/`blob:` so sanitized inline-SVG logos, wrapped
 *     raster data-URIs, and generated QR codes render — PLUS Dynamic's wallet-icon
 *     CDN (`iconic.dynamic-static-assets.com`) and WalletConnect's wallet-logo API
 *     (`explorer-api.walletconnect.com`), or the sign-in modal shows blank wallet
 *     tiles (the icons are `<img>`s from those hosts, not inline SVG).
 *   - `connect-src` allows `https:`/`wss:` because wallet RPC endpoints, Dynamic
 *     auth, World ID, and Google OIDC live on many origins that vary per chain.
 *   - `frame-src` allows `app.dynamicauth.com` for Dynamic's embedded-wallet /
 *     social-auth iframe; `frame-ancestors 'none'` + `object-src 'none'` kill
 *     clickjacking and plugin execution; `base-uri`/`form-action 'self'` block
 *     base-tag and form-action hijacking.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://iconic.dynamic-static-assets.com https://dynamic-static-assets.com https://explorer-api.walletconnect.com",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https://app.dynamicauth.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'upgrade-insecure-requests',
].join('; ')

/**
 * The baseline security headers applied to every route by {@link nextConfig}'s
 * `headers()`. Exported so a test can assert the set is present and complete
 * (red-report R-3).
 */
export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  // Clickjacking: legacy header alongside the CSP `frame-ancestors 'none'`.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Block MIME-sniffing so a text/* response can't be coerced into a script.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Force HTTPS for two years incl. subdomains (only honored over HTTPS).
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  // Don't leak full URLs (which can carry a checkout return_url) cross-origin.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Deny powerful features the checkout never needs.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Apply the baseline HTTP security headers to EVERY response (red-report R-3).
  // A single source-of-attack-surface block: CSP + framing/sniffing/HSTS/referrer
  // /permissions. See SECURITY_HEADERS for the rationale of each value.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS.map((h) => ({ key: h.key, value: h.value })),
      },
    ]
  },
  // Output a standalone Node.js server bundle for EC2/container deploys.
  output: 'standalone',
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
    // The one-tap deposit funding SDK (`@swype-org/deposit`) is also installed
    // only at the booth and ships here as a local type shim (types/deposit-sdk.d.ts).
    // Its only consumer is the guarded `lib/funding/loadSdk.ts` dynamic import, which
    // fails soft (DepositSdkUnavailableError) when the package is absent. Marking it
    // a `commonjs` external on BOTH the server and client bundles means webpack
    // emits a runtime `require` instead of trying to resolve the missing package at
    // build time: `next build` succeeds off a clean `main`, and the only consumer's
    // try/catch turns the missing-package require into "deposit_sdk_unavailable"
    // rather than wedging the build.
    config.externals = config.externals || []
    if (Array.isArray(config.externals)) {
      config.externals.push({ '@swype-org/deposit': 'commonjs @swype-org/deposit' })
    }
    return config
  },
}

export default nextConfig
