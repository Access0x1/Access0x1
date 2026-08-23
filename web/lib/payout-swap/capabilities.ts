/**
 * @file capabilities.ts — the per-chain swap capability flag (CHAINS.md, verified Jun 13).
 *
 * Capability is PER-CHAIN, not universal (spec law): a chain either has a same-chain payout
 * swap rail or it does not. The mapping is keyed by chain id (the live `arcTestnet.id`,
 * `baseSepolia.id`, `zksyncSepoliaTestnet.id` — never hardcoded numbers, guardrail #5) so it
 * stays in lock-step with `lib/chains.ts`. A chain not in the table is treated as NOT capable,
 * which fails safe: the worker no-ops and the merchant keeps settled USDC.
 *
 * Rail assignment (one job per rail, no logo-soup):
 *  - Arc → Circle App Kit Swap (Uniswap has nothing on Arc, our DEFAULT chain).
 *  - Base → Uniswap Trading API (/quote then /order gasless | /swap).
 *  - zkSync Era → Uniswap classic /swap (App Kit + CCTP do NOT support zkSync).
 *
 * There is deliberately NO 1inch row — see the note in the table below.
 */

import { baseSepolia, polygonAmoy, sepolia, zksyncSepoliaTestnet } from 'viem/chains'

import { arcTestnet } from '../chains.js'
import type { ChainSwapCapability, SwapRail } from './types.js'

/** The capability table: chainId → its same-chain swap rail. Absent ⇒ not capable. */
const CAPABILITIES: ReadonlyMap<number, SwapRail> = new Map<number, SwapRail>([
  [arcTestnet.id, 'circle-app-kit'],
  // Ethereum Sepolia — the app's HOME chain — is LIVE-VERIFIED (2026-07-25): a real
  // `/quote` against the production Trading API returned HTTP 200, CLASSIC routing,
  // a priced one-hop USDC→WETH route with a gas estimate. This is the one testnet
  // row backed by an actual served quote, not an assumption.
  [sepolia.id, 'uniswap-trading-api'],
  // Base Sepolia: probed the same day with the same canonical request — the API
  // answered `ResourceNotFound: "No quotes available"` for the canonical USDC→WETH
  // pair. That reads as no ROUTING there today (possibly pair-specific), not a
  // protocol error. The row stays because the rail is env-gated and dormant without
  // `UNISWAP_TRADING_API_URL`, so it promises nothing an operator has not themselves
  // supplied — but a Base-Sepolia swap must never be described as proven.
  [baseSepolia.id, 'uniswap-trading-api'],
  [zksyncSepoliaTestnet.id, 'uniswap-classic'],
  // NO 1inch ENTRY, DELIBERATELY. `polygonAmoy → 'one-inch'` used to live here and it
  // was a capability this rail cannot deliver: 1inch's API serves NO testnets, which
  // this repo states itself in lib/config/integrations.ts ("mainnets only"). The table
  // is the app's public answer to "can this chain swap?", so an entry here is a promise.
  // Claiming one on a chain the vendor does not serve — and which has no broadcast
  // record either — is exactly the overclaim law #4 forbids.
  //
  // The 1inch client in rails/oneInch.ts is kept: it is real code for a MAINNET
  // deployment, and its quote leg matches the v6 API. Re-add a mapping here only for a
  // chain 1inch actually serves, and only once the execute leg has a signer — the
  // current path in rails/oneInch.ts parses a `txHash` the API never returns.
])

/**
 * Resolve a chain's swap capability. Never throws — an unknown chain returns
 * `{ canSwap: false }` so the worker degrades to "no swap" rather than erroring on the
 * (already-final) money path.
 *
 * @param chainId The chain the settled USDC sits on.
 * @returns The capability flag (with the rail when capable).
 */
export function getSwapCapability(chainId: number): ChainSwapCapability {
  const rail = CAPABILITIES.get(chainId)
  if (!rail) return { chainId, canSwap: false }
  return { chainId, canSwap: true, rail }
}

/** Convenience predicate: does this chain support a same-chain payout swap at all? */
export function isSwapCapable(chainId: number): boolean {
  return CAPABILITIES.has(chainId)
}
