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
 *  - Base → Uniswap Trading API (/quote then /order gasless | /swap) — the headline demo.
 *  - zkSync Era → Uniswap classic /swap (App Kit + CCTP do NOT support zkSync).
 */

import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'

import { arcTestnet } from '../chains.js'
import type { ChainSwapCapability, SwapRail } from './types.js'

/** The capability table: chainId → its same-chain swap rail. Absent ⇒ not capable. */
const CAPABILITIES: ReadonlyMap<number, SwapRail> = new Map<number, SwapRail>([
  [arcTestnet.id, 'circle-app-kit'],
  [baseSepolia.id, 'uniswap-trading-api'],
  [zksyncSepoliaTestnet.id, 'uniswap-classic'],
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
