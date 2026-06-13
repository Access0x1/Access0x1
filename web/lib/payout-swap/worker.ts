/**
 * @file worker.ts — the async, OFF-CEI "Receive In Any Coin" payout-swap worker.
 *
 * Runs AFTER `_settle` is final. The router has already pushed net USDC into the merchant
 * lane (the money path is done). This worker reads that settled balance and, when the
 * merchant's `payoutToken !== USDC`, swaps USDC → `payoutToken` on the SAME chain via the
 * chain's rail. It is purely additive:
 *
 *   - it NEVER throws to its caller (a settlement webhook / queue consumer). Every failure
 *     becomes a {@link PayoutSwapResult} with `swapped: false` and a reason. A failed or
 *     skipped swap leaves the merchant holding settled USDC — a safe, valid end state (law #5).
 *   - the slippage floor (`minAmountOut`) is enforced HERE, against the rail's quote, BEFORE
 *     any execute call — a bad quote is rejected without touching merchant funds.
 *   - USDC default = no-op (the universal floor); the wrong chain (no rail) = no-op.
 *   - non-custodial: the injected {@link PayoutSwapClient} drives a merchant-signed swap; this
 *     worker never sees a key.
 */

import { isAddressEqual } from 'viem'

import { getSwapCapability } from './capabilities.js'
import type {
  PayoutSwapClient,
  PayoutSwapResult,
  SwapRequest,
} from './types.js'

/** A skip/fail result helper — keeps `swapped: false` end states uniform. */
function skip(reason: PayoutSwapResult['reason'], detail?: string): PayoutSwapResult {
  return { swapped: false, reason, detail }
}

/**
 * Run the payout swap for one settled payment. Branches by chain to the correct rail via the
 * injected client; enforces the slippage floor; isolates every failure.
 *
 * Ordering (off-CEI, additive):
 *  1. Validate the request (positive amount). Invalid ⇒ skip, never throw.
 *  2. USDC default: `payoutToken === usdc` ⇒ no swap (the floor). Skip with `usdc-default-no-op`.
 *  3. Chain capability: no rail for this chain ⇒ skip with `chain-not-capable`.
 *  4. Rail match: the injected client's rail must equal the chain's rail ⇒ else `rail-mismatch`.
 *  5. Quote: ask the rail for an expected output. A rejecting quote ⇒ `quote-failed` (no funds moved).
 *  6. Slippage floor: `amountOut < minAmountOut` ⇒ `slippage-exceeded` (no execute).
 *  7. Execute: merchant-signed swap. A rejecting execute ⇒ `execute-failed` (USDC stays with merchant).
 *
 * @param req    The same-chain swap request (settled USDC → merchant `payoutToken`).
 * @param client The per-chain rail client (DI seam; tests inject a mock, app injects the real rail).
 * @returns A {@link PayoutSwapResult}. NEVER rejects — failures are carried in the result.
 */
export async function runPayoutSwap(
  req: SwapRequest,
  client: PayoutSwapClient,
): Promise<PayoutSwapResult> {
  // 1. Validate. A non-positive amount is not a money path — never attempt a swap.
  if (req.amountUsdc <= 0n) {
    return skip('invalid-request', 'amountUsdc must be positive')
  }
  if (req.minAmountOut < 0n) {
    return skip('invalid-request', 'minAmountOut must be non-negative')
  }

  // 2. USDC default = the universal floor: same token in and out, nothing to swap.
  if (isAddressEqual(req.payoutToken, req.usdc)) {
    return skip('usdc-default-no-op', 'payoutToken is USDC — settled funds are already in the payout coin')
  }

  // 3. Per-chain capability flag. An unknown / unsupported chain degrades to no-swap.
  const cap = getSwapCapability(req.chainId)
  if (!cap.canSwap || !cap.rail) {
    return skip('chain-not-capable', `chain ${req.chainId} has no same-chain payout swap rail`)
  }

  // 4. The injected client must drive the rail this chain mandates (no Base rail on zkSync, etc.).
  if (client.rail !== cap.rail) {
    return skip(
      'rail-mismatch',
      `chain ${req.chainId} requires rail "${cap.rail}" but client drives "${client.rail}"`,
    )
  }

  // 5. Quote FIRST — enforce the floor before any state change. Isolate a failing rail.
  let quote
  try {
    quote = await client.quote(req)
  } catch (err) {
    return skip('quote-failed', errMsg(err))
  }

  // 6. Authoritative slippage bound — reject any quote below the caller's floor.
  if (quote.amountOut < req.minAmountOut) {
    return skip(
      'slippage-exceeded',
      `quote ${quote.amountOut} < minAmountOut ${req.minAmountOut}`,
    )
  }

  // 7. Execute (merchant-signed). A failure here leaves the merchant holding settled USDC (law #5).
  try {
    const exec = await client.execute(req, quote)
    return {
      swapped: true,
      rail: exec.rail,
      txHash: exec.txHash,
      amountOut: quote.amountOut,
      reason: 'none',
    }
  } catch (err) {
    return skip('execute-failed', errMsg(err))
  }
}

/** Extract a safe message string from an unknown thrown value (never leaks a stack / secret object). */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
