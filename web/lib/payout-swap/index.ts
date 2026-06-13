/**
 * @file index.ts — public surface of the "Receive In Any Coin" payout-swap worker.
 *
 * The worker ({@link runPayoutSwap}) is rail-agnostic: it takes a {@link PayoutSwapClient}
 * and branches by chain via {@link getSwapCapability}. {@link selectPayoutSwapClient} maps a
 * chain to the right rail constructor so a caller wires the per-chain dependencies once.
 *
 * This module is import-clean (no server secrets, no top-level SDK construction) so the worker
 * and capability table can be unit-tested in isolation; the rail clients receive their
 * transport/SDK seams at construction time.
 */

import { getSwapCapability } from './capabilities.js'
import { createCircleAppKitClient, type AppKitSwapSdk } from './rails/circleAppKit.js'
import {
  createUniswapClassicClient,
  type UniswapClassicConfig,
} from './rails/uniswapClassic.js'
import {
  createUniswapTradingApiClient,
  type UniswapTradingApiConfig,
} from './rails/uniswapTradingApi.js'
import type { PayoutSwapClient } from './types.js'

export { runPayoutSwap } from './worker.js'
export { getSwapCapability, isSwapCapable } from './capabilities.js'
export { createUniswapTradingApiClient } from './rails/uniswapTradingApi.js'
export { createUniswapClassicClient } from './rails/uniswapClassic.js'
export { createCircleAppKitClient } from './rails/circleAppKit.js'
export type {
  PayoutSwapClient,
  PayoutSwapResult,
  SwapRequest,
  SwapRail,
  SwapSkipReason,
  ChainSwapCapability,
  RailQuote,
  RailExecution,
} from './types.js'

/** The per-chain rail dependencies a caller supplies to build the right client. */
export interface PayoutSwapDeps {
  /** Base → Uniswap Trading API config (transport + base URL). */
  readonly uniswapTradingApi?: UniswapTradingApiConfig
  /** zkSync → Uniswap classic config (transport + RPC submit, optional Blink). */
  readonly uniswapClassic?: UniswapClassicConfig
  /** Arc → Circle App Kit Swap SDK (viem-native, merchant-signed). */
  readonly circleAppKit?: AppKitSwapSdk
}

/**
 * Select the swap client for a chain, or `null` when the chain has no rail (the worker then
 * no-ops with `chain-not-capable`). Throws only when the chain IS capable but the matching
 * dependency was not supplied — a wiring error that should surface loudly at boot, not silently
 * skip a configured feature.
 *
 * @param chainId The chain the settled USDC sits on.
 * @param deps    The per-chain rail dependencies.
 * @returns The {@link PayoutSwapClient} for the chain, or `null` if the chain is not capable.
 * @throws {Error} when the chain is capable but its rail dependency is missing.
 */
export function selectPayoutSwapClient(
  chainId: number,
  deps: PayoutSwapDeps,
): PayoutSwapClient | null {
  const cap = getSwapCapability(chainId)
  if (!cap.canSwap || !cap.rail) return null

  switch (cap.rail) {
    case 'uniswap-trading-api':
      if (!deps.uniswapTradingApi) {
        throw new Error(`chain ${chainId} uses uniswap-trading-api but no config was supplied`)
      }
      return createUniswapTradingApiClient(deps.uniswapTradingApi)
    case 'uniswap-classic':
      if (!deps.uniswapClassic) {
        throw new Error(`chain ${chainId} uses uniswap-classic but no config was supplied`)
      }
      return createUniswapClassicClient(deps.uniswapClassic)
    case 'circle-app-kit':
      if (!deps.circleAppKit) {
        throw new Error(`chain ${chainId} uses circle-app-kit but no SDK was supplied`)
      }
      return createCircleAppKitClient(deps.circleAppKit)
  }
}
