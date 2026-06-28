/**
 * index.ts — the OPTIONAL "pay in any token → settle USDC" swap orchestrator (Flow).
 *
 * `prepareFlowSwap()` is the SEAM that would convert an arbitrary buyer-held token
 * into the USDC the existing pay path settles in, off the Solidity money path. The
 * swapped USDC lands in the buyer/agent EOA and then flows into the UNCHANGED
 * CheckoutCard → payToken path — this module never settles the payment itself.
 *
 * ⚠️ TRUTH (law #4 — read this before trusting the result):
 * No real swap aggregator / SDK is integrated in this repo. The swap STEP is a
 * documented ADAPTER (a `SwapAdapter` injected exactly like the Unlink/Blink
 * loadSdk seam). The DEFAULT adapter is a STUB that performs NO swap and returns
 * `swap_adapter_unavailable`. This module therefore NEVER reports that a token was
 * "swapped" or "settled" — at most it reports the seam is wired and what's missing.
 * Wiring a real aggregator = providing a `SwapAdapter` (and an env provider/app id),
 * not editing this orchestrator.
 *
 * PURE + FAIL-SOFT (matches lib/onramp + lib/funding/blink):
 *   - All env reads go through `config.ts`; this module is pure orchestration.
 *   - UNCONFIGURED ⇒ `{ ok:false, code:'not_configured' }` — never a guessed swap.
 *   - ADAPTER ABSENT (the default) ⇒ `{ ok:false, code:'swap_adapter_unavailable' }`
 *     — honest "wired but not swapping", no funds moved, NEVER throws.
 *   - No secret ever enters a result: a server-only key (if a provider needs one)
 *     stays server-side and is never logged or returned.
 */

import {
  flowAppId,
  flowProvider,
  flowSettleAsset,
  isFlowConfigured,
  type FlowProvider,
} from './config'

/** A token the buyer wants to pay WITH (the input side of the swap). */
export interface FlowInputToken {
  /** ERC-20 contract address of the token the buyer holds. REQUIRED (0x, 20-byte). */
  address: `0x${string}`
  /** Human amount of the input token to swap (e.g. "12.5"). REQUIRED. */
  amount: string
  /** Optional symbol for display only (never trusted for routing). */
  symbol?: string
}

/** Inputs to prepare a Flow swap into the settlement asset (USDC). */
export interface FlowSwapInput {
  /** The chain the pay path settles on (the swap output must land here). */
  chainId: number
  /** The buyer/agent EOA that holds the input token and receives the USDC. */
  address: `0x${string}`
  /** The token the buyer wants to pay with. */
  inputToken: FlowInputToken
}

/**
 * The result of a Flow swap preparation. On the ONLY success path the adapter has
 * actually produced a swap (a real aggregator was provided) and reports the USDC
 * output amount + the route reference — this orchestrator does NOT fabricate that.
 */
export type FlowSwapResult =
  | {
      ok: true
      provider: FlowProvider
      /** The settlement asset the input was swapped INTO (USDC by default). */
      settleAsset: string
      /** Human amount of settlement asset the adapter reports it produced. */
      settledAmount: string
      /** Adapter-provided route/quote reference (e.g. an aggregator route id). */
      routeRef: string
      /** Optional on-chain tx hash IF the adapter executed the swap on-chain. */
      txHash?: `0x${string}`
    }
  | {
      ok: false
      code: 'not_configured' | 'invalid_input' | 'swap_adapter_unavailable' | 'swap_failed'
      reason: string
    }

/**
 * The narrow surface a real swap aggregator must provide to make the Flow option
 * actually swap. Injected (like the Unlink/Blink loadSdk seam) so a real
 * integration is a SEPARATE change — never an edit to this orchestrator — and so a
 * test can pass a fake. The default ({@link unavailableSwapAdapter}) is a stub.
 */
export interface SwapAdapter {
  /**
   * Quote + perform the swap of `input.inputToken` into `settleAsset` on
   * `input.chainId`, delivering to `input.address`. A real adapter returns the
   * settlement amount + route reference (+ tx hash if it executed on-chain). It
   * may throw; the orchestrator catches it as `swap_failed` (fail-soft).
   */
  swapToSettlement(
    input: FlowSwapInput,
    settleAsset: string,
  ): Promise<{ settledAmount: string; routeRef: string; txHash?: `0x${string}` }>
}

/**
 * Thrown by the DEFAULT adapter to mark the honest truth: no swap aggregator is
 * wired in this build, so NO swap can be performed. `recoverable` mirrors the
 * money-path law (#5): NO funds moved, the operation can run once a real adapter
 * is provided. Carries NO secret and NO guessed address (law #4).
 */
export class SwapAdapterUnavailableError extends Error {
  readonly recoverable = true as const
  readonly code = 'swap_adapter_unavailable' as const
  constructor(cause?: unknown) {
    super(
      'swap_adapter_unavailable: no swap aggregator is wired in this build. The ' +
        '"pay in any token → USDC" swap is a documented seam only; provide a real ' +
        'SwapAdapter to enable it. No funds moved; no token was swapped or settled.',
    )
    this.name = 'SwapAdapterUnavailableError'
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

/**
 * The DEFAULT swap adapter: a documented STUB that performs NO swap. It always
 * throws {@link SwapAdapterUnavailableError}, so the orchestrator reports
 * `swap_adapter_unavailable` and the option NEVER claims a token was swapped or
 * settled (law #4). Replace by passing a real {@link SwapAdapter} to
 * {@link prepareFlowSwap} once an aggregator SDK is integrated.
 */
export const unavailableSwapAdapter: SwapAdapter = {
  async swapToSettlement(): Promise<never> {
    throw new SwapAdapterUnavailableError()
  },
}

/** True only for a plausibly-real 0x EOA/contract address (20-byte hex). */
function isHexAddress(v: string): v is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(v)
}

/**
 * Prepare a Flow "pay in any token → USDC" swap, fully fail-soft and honest.
 *
 * The swap adapter is injected (defaults to the {@link unavailableSwapAdapter}
 * stub), so off a clean build the result is ALWAYS `swap_adapter_unavailable` —
 * the seam is wired but performs no swap. Returns:
 *   - `not_configured`          — the Flow option is off / no provider / no app id.
 *   - `invalid_input`           — missing/malformed address or amount (never guessed).
 *   - `swap_adapter_unavailable`— configured, but no real swap adapter is wired.
 *   - `swap_failed`             — a real adapter ran but errored (clean reason).
 *   - `{ ok:true, ... }`        — a real adapter reported a swap (this fn never fakes it).
 *
 * NEVER throws. No secret enters the result. No address/amount is ever invented.
 */
export async function prepareFlowSwap(
  input: FlowSwapInput,
  adapter: SwapAdapter = unavailableSwapAdapter,
): Promise<FlowSwapResult> {
  if (!isFlowConfigured()) {
    return {
      ok: false,
      code: 'not_configured',
      reason:
        'Pay-in-any-token is not configured. Set NEXT_PUBLIC_FLOW_ENABLED=true + ' +
        'FLOW_PROVIDER + NEXT_PUBLIC_FLOW_APP_ID to enable it.',
    }
  }

  const provider = flowProvider()
  // isFlowConfigured already guarantees a known provider; this narrows the type
  // and guards against config drift between the two reads.
  if (provider === undefined) {
    return { ok: false, code: 'not_configured', reason: 'No swap provider selected.' }
  }

  if (typeof input.address !== 'string' || !isHexAddress(input.address)) {
    return {
      ok: false,
      code: 'invalid_input',
      reason: 'A valid 0x recipient address is required to prepare a swap.',
    }
  }
  if (
    typeof input.inputToken?.address !== 'string' ||
    !isHexAddress(input.inputToken.address)
  ) {
    return {
      ok: false,
      code: 'invalid_input',
      reason: 'A valid 0x input-token address is required to prepare a swap.',
    }
  }
  const amount = (input.inputToken?.amount ?? '').trim()
  if (amount.length === 0 || !(Number(amount) > 0)) {
    return {
      ok: false,
      code: 'invalid_input',
      reason: 'A positive input-token amount is required to prepare a swap.',
    }
  }

  const settleAsset = flowSettleAsset()
  // The public app id is read here only to assert the seam is wired; it is NOT
  // returned or logged. (A server-only key, if any, stays in config.ts.)
  if (flowAppId().length === 0) {
    return { ok: false, code: 'not_configured', reason: 'No Flow app id configured.' }
  }

  try {
    const out = await adapter.swapToSettlement(input, settleAsset)
    return {
      ok: true,
      provider,
      settleAsset,
      settledAmount: out.settledAmount,
      routeRef: out.routeRef,
      txHash: out.txHash,
    }
  } catch (err) {
    // The default stub lands here with the honest "no aggregator wired" signal;
    // a real adapter's failure lands here too (clean reason, no secret, no throw).
    if (err instanceof SwapAdapterUnavailableError) {
      return { ok: false, code: 'swap_adapter_unavailable', reason: err.message }
    }
    const reason = err instanceof Error ? err.message : 'Swap failed.'
    return { ok: false, code: 'swap_failed', reason }
  }
}

export {
  isFlowConfigured,
  isFlowPublicConfigured,
  isFlowEnabled,
  flowProvider,
  flowSettleAsset,
  FLOW_CONFIGURE_NOTE,
  KNOWN_FLOW_PROVIDERS,
  type FlowProvider,
} from './config'
