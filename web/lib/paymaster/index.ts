/**
 * index.ts — the ERC-7677 / EIP-5792 sponsored-gas paymaster seam.
 *
 * This module is the public surface of `lib/paymaster`. It re-exports
 * everything a checkout component or API route needs to work with the paymaster
 * seam — the config predicates, the EIP-5792 capability builder, and the
 * type definitions — so callers import from a single path (`@/lib/paymaster`)
 * rather than from the internal sub-files.
 *
 * FAIL-SOFT: every exported function returns a safe default when the paymaster
 * is unconfigured (false / undefined / 0). Nothing here throws. The checkout
 * falls back to the normal EOA gas flow transparently.
 *
 * ERC-7677 / EIP-5792 shape:
 *   - The wallet receives a `paymasterService` capability via EIP-5792's
 *     `wallet_sendCalls` call; this module builds that capability object.
 *   - The bundler calls `pm_getPaymasterStubData` / `pm_getPaymasterData`
 *     against the paymaster URL automatically once the capability is attached.
 *   - This seam never calls those methods directly; the wallet handles them.
 *
 * What the calling component needs to do:
 *   1. Call `isPaymasterActiveForChain(chainId)` — true iff a paymaster is
 *      configured AND covers this checkout's chain id.
 *   2. When true, render the gas-sponsored badge and attach
 *      `paymasterCapability()` to the `wallet_sendCalls` call capabilities.
 *   3. When false, render nothing extra and proceed with the normal EOA flow.
 */

import {
  isPaymasterConfigured,
  paymasterUrl,
  paymasterChainId,
} from './config'

export {
  isPaymasterEnabled,
  isPaymasterConfigured,
  isPaymasterPublicConfigured,
  isPaymasterActiveForChain,
  paymasterUrl,
  paymasterChainId,
  paymasterCapability,
  PAYMASTER_CONFIGURE_NOTE,
} from './config'

// ---------------------------------------------------------------------------
// Type: the discriminated result a paymaster-aware API route can return
// ---------------------------------------------------------------------------

/**
 * Discriminated result for a server-side paymaster capability check. Use this
 * in API routes that need to report whether sponsorship is available.
 *
 * `ok: true` — the paymaster is configured for the requested chain; the
 *   capability URL is safe to forward to the wallet.
 * `ok: false, code: 'not_configured'` — the seam is unconfigured; the route
 *   should answer 503 and the checkout falls back to the normal gas flow.
 * `ok: false, code: 'chain_mismatch'` — the paymaster exists but does not
 *   cover the requested chain; never claim sponsorship for a different chain.
 */
export type PaymasterCheckResult =
  | { ok: true; url: string; chainId: number }
  | { ok: false; code: 'not_configured' | 'chain_mismatch'; reason: string }

/**
 * Build a `PaymasterCheckResult` for a given chain id.
 *
 * Returns `{ ok: true }` when the paymaster is configured AND covers `chainId`.
 * Returns `{ ok: false, code: 'not_configured' }` when the seam is unconfigured.
 * Returns `{ ok: false, code: 'chain_mismatch' }` when the paymaster exists but
 * covers a different chain — we never claim gas sponsorship cross-chain.
 *
 * NEVER throws. The checkout's pay path must remain intact regardless of this
 * result (the paymaster is a gas-cost optimization, not a payment rail).
 */
export function resolvePaymasterForChain(chainId: number): PaymasterCheckResult {
  if (!isPaymasterConfigured()) {
    return {
      ok: false,
      code: 'not_configured',
      reason:
        'Gas sponsorship is not configured. Set PAYMASTER_ENABLED=true + ' +
        'NEXT_PUBLIC_PAYMASTER_URL + NEXT_PUBLIC_PAYMASTER_CHAIN_ID to enable it.',
    }
  }

  const configuredChainId = paymasterChainId()
  if (configuredChainId !== chainId) {
    return {
      ok: false,
      code: 'chain_mismatch',
      reason:
        `The configured paymaster covers chain ${configuredChainId}, ` +
        `not chain ${chainId}. Gas is not sponsored on this chain.`,
    }
  }

  return {
    ok: true,
    url: paymasterUrl(),
    chainId,
  }
}
