/**
 * @file types.ts — shared types for the "Receive In Any Coin" payout-swap worker.
 *
 * The merchant is paid in their configured `payoutToken`. The router ALWAYS settles
 * net USDC into the merchant lane (the money path). When `payoutToken !== USDC`, an
 * ASYNC, OFF-CEI worker (never inside `_settle`) swaps the settled USDC into the
 * merchant's coin AFTER settlement is final. A failed swap costs nothing and leaves
 * the merchant holding settled USDC (law #5 — purely additive).
 *
 * Non-custodial throughout: the merchant (or a merchant-controlled server wallet) is
 * the swap caller/signer. Access0x1 holds no keys and no funds — these types carry the
 * merchant wallet address but never a private key. The per-chain rail (Uniswap Trading
 * API on Base, Circle App Kit on Arc, Uniswap classic on zkSync) is captured behind the
 * {@link PayoutSwapClient} seam so the worker is fully unit-testable offline.
 */

import type { Address } from 'viem'

/**
 * Which same-chain swap rail a chain uses (per CHAINS.md, verified Jun 13).
 *  - `uniswap-trading-api`: Base → Uniswap Trading API (/quote then /order gasless | /swap).
 *  - `circle-app-kit`: Arc → Circle App Kit Swap (Uniswap has nothing on Arc, our default chain).
 *  - `uniswap-classic`: zkSync Era → Uniswap classic /swap (App Kit + CCTP do NOT support zkSync).
 *  - `one-inch`: 1inch Aggregation/Swap API — the aggregator rail (Fusion gasless | classic /swap),
 *    an alternative on chains 1inch covers; env-gated + dormant until `ONEINCH_API_URL` is set.
 */
export type SwapRail = 'uniswap-trading-api' | 'circle-app-kit' | 'uniswap-classic' | 'one-inch'

/** Per-chain swap capability: whether a same-chain payout swap is possible, and via which rail. */
export interface ChainSwapCapability {
  /** The chain this capability describes. */
  readonly chainId: number
  /** Whether the worker may attempt a swap on this chain at all (the per-chain flag). */
  readonly canSwap: boolean
  /** The rail to use when `canSwap`. Undefined when `canSwap` is false. */
  readonly rail?: SwapRail
}

/**
 * A request to swap settled USDC into the merchant's `payoutToken` on one chain.
 *
 * `amountUsdc` and `minAmountOut` are atomic integer amounts (the token's own decimals),
 * never floats — the worker does no decimal math, it only compares the rail's quoted
 * output against the caller-supplied floor.
 */
export interface SwapRequest {
  /** The chain the settled USDC sits on (same-chain swap; not a bridge). */
  readonly chainId: number
  /** The settled-USDC token address (the input asset). */
  readonly usdc: Address
  /** The merchant's configured payout token (the output asset). */
  readonly payoutToken: Address
  /** The merchant wallet that holds the settled USDC and signs the swap (non-custodial). */
  readonly merchant: Address
  /** Settled USDC amount to swap, in USDC base units (atomic integer). */
  readonly amountUsdc: bigint
  /**
   * The minimum acceptable output amount (atomic, in `payoutToken` decimals) — the
   * slippage floor. The worker REJECTS any quote whose `amountOut` is below this; the
   * rail's own slippage param is belt-and-suspenders, this bound is authoritative.
   */
  readonly minAmountOut: bigint
}

/** The outcome of a single rail call (quote or execute). Errors are carried, never thrown across the seam. */
export interface RailQuote {
  /** The rail's quoted/expected output amount, atomic in `payoutToken` decimals. */
  readonly amountOut: bigint
}

/** The result of executing a swap on a rail (a submitted/landed tx). */
export interface RailExecution {
  /** The swap transaction hash, for the merchant's records / explorer link. */
  readonly txHash: string
  /** The rail that executed it (for telemetry / the demo). */
  readonly rail: SwapRail
}

/**
 * The injectable per-chain swap rail. ONE method per leg so each rail (Uniswap Trading
 * API, Circle App Kit, Uniswap classic) implements the same shape. The worker calls
 * `quote` first (to enforce the slippage floor BEFORE any state change), then `execute`.
 *
 * Implementations are non-custodial: `execute` asks the merchant's wallet/server-wallet
 * to sign — this seam never receives a private key.
 */
export interface PayoutSwapClient {
  /** Which rail this client drives (must match the chain's capability). */
  readonly rail: SwapRail
  /** Fetch an expected-output quote for the request. May reject (the worker isolates it). */
  quote(req: SwapRequest): Promise<RailQuote>
  /** Execute the swap (merchant-signed). May reject (the worker isolates it). */
  execute(req: SwapRequest, quote: RailQuote): Promise<RailExecution>
}

/** Why a payout swap did not execute. `none` = it ran (or correctly no-op'd). */
export type SwapSkipReason =
  | 'usdc-default-no-op' // payoutToken === USDC: nothing to swap (the universal floor).
  | 'chain-not-capable' // the chain's flag says no swap rail here.
  | 'rail-mismatch' // the injected client's rail does not match the chain's capability.
  | 'slippage-exceeded' // the rail quote was below `minAmountOut`.
  | 'quote-failed' // the rail's quote call rejected.
  | 'execute-failed' // the rail's execute call rejected (settled USDC stays with merchant).
  | 'invalid-request' // amount <= 0 etc.

/**
 * The worker's result. NEVER throws — a failed/skipped swap is reported, not raised, so it
 * can never block or roll back the (already-final) settlement (law #5). `swapped: false`
 * always means "the merchant still holds settled USDC", which is a safe, valid end state.
 */
export interface PayoutSwapResult {
  /** True only when a swap executed and met the slippage floor. */
  readonly swapped: boolean
  /** The rail used (present iff `swapped`). */
  readonly rail?: SwapRail
  /** The swap tx hash (present iff `swapped`). */
  readonly txHash?: string
  /** The quoted/landed output amount (present iff `swapped`). */
  readonly amountOut?: bigint
  /** Why no swap happened (`none` iff `swapped`). */
  readonly reason: SwapSkipReason | 'none'
  /** A human-readable detail for telemetry / the demo (never a secret). */
  readonly detail?: string
}
