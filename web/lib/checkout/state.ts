/**
 * @file state.ts — the branded-checkout transaction state machine.
 *
 * The hosted checkout (`/c/{slug}`) moves a buyer through a strict lifecycle:
 * fetch a live quote → ask the wallet to sign → broadcast → wait for the
 * receipt → confirmed or failed. Every prior version of this lived as a tangle
 * of `useState` booleans (`loadingQuote`, `paying`, `payError`, `receipt`) in
 * the component, which made three things easy to get wrong and impossible to
 * test in isolation:
 *
 *   1. **Ambiguous tx states** — "paying" conflated "waiting for the wallet
 *      popup", "broadcast, waiting for a block", and "failed". A buyer staring
 *      at "Confirming…" couldn't tell whether their wallet was waiting on them.
 *   2. **Double-charge risk** — a second click (or a retry after a wallet
 *      timeout) could broadcast a SECOND pay tx while the first was still in the
 *      mempool. No custody means no server-side dedupe; the guard must live
 *      client-side, keyed on the in-flight tx hash.
 *   3. **Stale-price / rejection handling** — an `OracleLib__StalePrice` revert
 *      or a user-rejected signature both surfaced as a generic "Payment failed".
 *
 * This module is the single source of truth for that lifecycle. It is PURE
 * (no React, no viem calls, no I/O) so it is exhaustively unit-testable and can
 * be driven by any UI. The component (`CheckoutClient.tsx`) owns the effects
 * (fetching quotes, signing, waiting for receipts) and dispatches events here;
 * this reducer owns the truth about WHICH state is legal next.
 *
 * Design notes:
 *  - **One quote, idempotent retry.** Each successful quote gets a monotonic
 *    `quoteNonce`. A retry after a transient failure (stale feed, RPC blip,
 *    wallet timeout) reuses the SAME nonce — the buyer is retrying ONE payment,
 *    not starting a new one. A genuinely new quote (token switch, amount change,
 *    quote expiry) bumps the nonce, which invalidates any in-flight guard.
 *  - **Never-double-charge guard keyed on the tx hash.** Once `payToken` returns
 *    a tx hash, that hash is recorded on the state. Any attempt to broadcast
 *    again while a hash is in flight for the current quote is rejected by the
 *    reducer (the dispatch is a no-op that keeps the pending state). The guard
 *    is released only by a terminal event (confirmed/failed) or an explicit
 *    new-quote reset.
 *  - **Errors are CLASSIFIED, not stringly-typed.** `classifyPayError` maps a
 *    raw thrown value (viem `BaseError`, a custom-error name, a network blip)
 *    into a small closed set with a buyer-readable message and a `retryable`
 *    flag, so the UI never shows a hex blob and never offers a pointless retry.
 */

import type { Hash } from 'viem'
import type { PaymentReceivedEvent } from '@/lib/contracts'

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The closed set of checkout failure kinds. Keeping this a finite union (rather
 * than free-form strings) lets the UI branch exhaustively and lets tests assert
 * the exact classification of every revert path (law #4 — surface every revert).
 *
 *  - `wallet_rejected`  — the buyer dismissed/denied the signature request (viem
 *                         `UserRejectedRequestError`, EIP-1193 code 4001). Not an
 *                         error in the failure sense; offer a clean retry.
 *  - `oracle_stale`     — the Chainlink feed round was stale inside the pay tx
 *                         (`OracleLib__StalePrice`). Transient; re-quote + retry.
 *  - `invalid_price`    — the feed returned a non-positive answer
 *                         (`Access0x1__InvalidPrice`). Transient; retry shortly.
 *  - `underpaid`        — the settled amount came in under the quote
 *                         (`Access0x1__Underpaid`), e.g. the price moved between
 *                         quote and settle. Re-quote + retry.
 *  - `merchant_inactive`— the merchant is not accepting payments right now.
 *  - `token_not_allowed`— the chosen token is not allowlisted for this router.
 *  - `insufficient_funds`— the buyer's balance can't cover the amount (+ gas).
 *  - `network`          — an RPC/transport blip with no decodable revert. Retry.
 *  - `unknown`          — anything we couldn't classify. Retry is allowed but the
 *                         message stays generic (never echo a raw hex blob).
 */
export type PayErrorKind =
  | 'wallet_rejected'
  | 'oracle_stale'
  | 'invalid_price'
  | 'underpaid'
  | 'merchant_inactive'
  | 'token_not_allowed'
  | 'insufficient_funds'
  | 'network'
  | 'unknown'

/** A classified, buyer-readable failure. The UI renders `message`; logic branches on `kind`. */
export interface PayError {
  /** The closed-set kind, for exhaustive UI branching + tests. */
  readonly kind: PayErrorKind
  /** A human-readable, non-technical message safe to show a buyer (no hex, no stack). */
  readonly message: string
  /**
   * Whether re-attempting the SAME payment can reasonably succeed. A stale feed,
   * a wallet rejection, or a network blip are retryable; an inactive merchant or
   * a disallowed token are not (the buyer must change something upstream).
   */
  readonly retryable: boolean
}

/**
 * Map a known Access0x1 / OracleLib custom-error name (or generic substring) to a
 * classified `PayError`. The contract reverts are matched by NAME — viem surfaces
 * the decoded error name in the thrown error's message/metadata. The token symbol
 * is threaded in so an insufficient-balance / underpaid message names the RIGHT
 * coin (never a hardcoded "USDC" when paying in another allowlisted token).
 */
const REVERT_TABLE: ReadonlyArray<{ needle: string; kind: PayErrorKind; retryable: boolean; message: (token: string) => string }> = [
  {
    needle: 'OracleLib__StalePrice',
    kind: 'oracle_stale',
    retryable: true,
    message: () => 'The price feed is briefly stale. Please try again in a moment.',
  },
  {
    needle: 'Access0x1__InvalidPrice',
    kind: 'invalid_price',
    retryable: true,
    message: () => 'The price feed returned an invalid value. Please try again shortly.',
  },
  {
    needle: 'Access0x1__Underpaid',
    kind: 'underpaid',
    retryable: true,
    message: () => 'The price moved while you were paying. We re-quoted — please try again.',
  },
  {
    needle: 'Access0x1__MerchantInactive',
    kind: 'merchant_inactive',
    retryable: false,
    message: () => 'This merchant is not currently accepting payments.',
  },
  {
    needle: 'Access0x1__MerchantNotFound',
    kind: 'merchant_inactive',
    retryable: false,
    message: () => 'This checkout link is not registered yet.',
  },
  {
    needle: 'Access0x1__TokenNotAllowed',
    kind: 'token_not_allowed',
    retryable: false,
    message: (token) => `${token} is not accepted for this payment.`,
  },
  {
    needle: 'Access0x1__FeeOnTransferToken',
    kind: 'token_not_allowed',
    retryable: false,
    message: (token) => `${token} can't be used here — it charges a transfer fee.`,
  },
  {
    needle: 'Access0x1__ZeroAmount',
    kind: 'invalid_price',
    retryable: true,
    message: () => 'The amount quoted was zero. Please try again shortly.',
  },
]

/**
 * Detect a user-rejected wallet request. viem throws a `UserRejectedRequestError`
 * whose `name`/`shortMessage` carry that string and which wraps the EIP-1193
 * `{ code: 4001 }`. We match defensively on BOTH the viem error name and the
 * raw provider code so every wallet (MetaMask, Coinbase, WalletConnect, the
 * Dynamic embedded wallet) is covered — wallets word the message differently but
 * all return 4001.
 */
function isUserRejection(err: unknown): boolean {
  const message = errorText(err)
  if (/UserRejectedRequest|User rejected|User denied|rejected the request|denied transaction/i.test(message)) {
    return true
  }
  // EIP-1193 standard rejection code, possibly nested on `.cause` / `.walk()`.
  const code = extractProviderCode(err)
  return code === 4001
}

/** Pull a flat, lowercase-safe string out of any thrown value for substring matching. */
function errorText(err: unknown): string {
  if (err instanceof Error) {
    // viem errors expose extra context on `shortMessage`/`metaMessages`; include them.
    const extra = (err as { shortMessage?: string; metaMessages?: string[] })
    const parts = [err.message, extra.shortMessage, ...(extra.metaMessages ?? [])].filter(Boolean)
    // Walk the cause chain so a nested custom-error name (wrapped by viem's
    // ContractFunctionExecutionError) is still matched.
    let cause: unknown = (err as { cause?: unknown }).cause
    let depth = 0
    while (cause && depth < 8) {
      if (cause instanceof Error) parts.push(cause.message)
      else if (typeof cause === 'string') parts.push(cause)
      cause = (cause as { cause?: unknown })?.cause
      depth += 1
    }
    return parts.join(' :: ')
  }
  return typeof err === 'string' ? err : JSON.stringify(err ?? '')
}

/** Find an EIP-1193 numeric error code anywhere on the error or its cause chain. */
function extractProviderCode(err: unknown): number | undefined {
  let node: unknown = err
  let depth = 0
  while (node && depth < 8) {
    const code = (node as { code?: unknown }).code
    if (typeof code === 'number') return code
    node = (node as { cause?: unknown }).cause
    depth += 1
  }
  return undefined
}

/**
 * Classify any thrown pay-path value into a buyer-readable {@link PayError}.
 *
 * Order matters: a wallet rejection is checked first (it is the most common and
 * most specific), then the known contract reverts by name, then balance/network
 * heuristics, then a safe generic fallback. We NEVER surface a raw hex revert
 * blob or a stack trace to the buyer.
 *
 * @param err    The raw thrown value (a viem `BaseError`, a custom-error name, etc.).
 * @param token  The symbol of the token being paid in, so balance/allowlist
 *               messages name the correct coin (truth-in-copy, law #4).
 */
export function classifyPayError(err: unknown, token = 'tokens'): PayError {
  if (isUserRejection(err)) {
    return {
      kind: 'wallet_rejected',
      message: 'You dismissed the request in your wallet. No payment was made — tap Pay to try again.',
      retryable: true,
    }
  }

  const message = errorText(err)

  for (const row of REVERT_TABLE) {
    if (message.includes(row.needle)) {
      return { kind: row.kind, message: row.message(token), retryable: row.retryable }
    }
  }

  // Balance heuristics (no custom error — the wallet/RPC simulation rejects).
  if (/insufficient funds|exceeds balance|insufficient balance|transfer amount exceeds balance/i.test(message)) {
    return {
      kind: 'insufficient_funds',
      message: `You don't have enough ${token} to cover this payment and gas.`,
      retryable: false,
    }
  }

  // Transport/RPC blips: a timeout, a connection reset, an over-rate-limit. Retryable.
  if (/timed out|timeout|fetch failed|network|connection|rate limit|429|503|ECONN/i.test(message)) {
    return {
      kind: 'network',
      message: 'The network hiccuped. Please check your connection and try again.',
      retryable: true,
    }
  }

  return {
    kind: 'unknown',
    message: 'The payment could not be completed. Please try again.',
    retryable: true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The state machine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The lifecycle phases of one checkout session. Linear with two terminal exits:
 *
 *   idle ─► quoting ─► quoted ─► awaiting_signature ─► pending ─► confirmed
 *             │           ▲                │                          │
 *             ▼           │                ▼ (4001)                   │
 *         quote_error ────┘             quoted ◄── failed ◄───────────┘ (revert)
 *
 *  - `idle`               — nothing requested yet (e.g. wallet not connected).
 *  - `quoting`            — a live `/api/quote` fetch is in flight.
 *  - `quoted`             — a fresh quote is held; Pay is enabled.
 *  - `quote_error`        — the quote fetch failed (stale feed, RPC blip); Pay is
 *                           disabled with a retry that re-quotes.
 *  - `awaiting_signature` — the wallet popup is open, waiting for the buyer to
 *                           sign (approve and/or pay). NOT yet broadcast.
 *  - `pending`            — a pay tx hash exists and we're waiting for the
 *                           receipt. The double-charge guard is ARMED here.
 *  - `confirmed`          — the `PaymentReceived` event is in hand. Terminal.
 *  - `failed`             — the pay tx reverted or threw. Carries a classified
 *                           {@link PayError}; retry returns to `quoted`.
 */
export type CheckoutPhase =
  | 'idle'
  | 'quoting'
  | 'quoted'
  | 'quote_error'
  | 'awaiting_signature'
  | 'pending'
  | 'confirmed'
  | 'failed'

/**
 * The full checkout state. Immutable — the reducer always returns a new object.
 * Fields are present only in the phases where they are meaningful (documented
 * per field), but kept on one flat shape so the component reads them without
 * narrowing gymnastics; the `phase` discriminant is the authority.
 */
export interface CheckoutState {
  /** The current lifecycle phase (the discriminant). */
  readonly phase: CheckoutPhase
  /**
   * Monotonic id of the CURRENT quote. Bumped on every genuinely new quote
   * (mount, token switch, amount change, manual re-quote). The double-charge
   * guard and idempotent retry are scoped to this nonce: a retry keeps it, a
   * new quote invalidates any in-flight payment tied to the old nonce.
   */
  readonly quoteNonce: number
  /** The display string for the held quote (e.g. "29.01"), present in `quoted`+. */
  readonly quoteDisplay: string | null
  /** The quoted token amount in the token's own decimals, present in `quoted`+. */
  readonly quoteTokenAmount: bigint | null
  /**
   * The in-flight pay tx hash, set the instant `payToken` returns a hash and held
   * through `pending`. This is the never-double-charge key: while it is non-null
   * for the current `quoteNonce`, the reducer refuses to begin another payment.
   * Cleared on a terminal transition or a new quote.
   */
  readonly txHash: Hash | null
  /** The classified failure, present only in `failed`. */
  readonly error: PayError | null
  /** The settled `PaymentReceived` event, present only in `confirmed`. */
  readonly receipt: PaymentReceivedEvent | null
}

/** The initial state: idle, with the first quote nonce reserved as 0. */
export const initialCheckoutState: CheckoutState = {
  phase: 'idle',
  quoteNonce: 0,
  quoteDisplay: null,
  quoteTokenAmount: null,
  txHash: null,
  error: null,
  receipt: null,
}

/**
 * Events the component dispatches as effects resolve. Each models one real-world
 * occurrence; the reducer decides whether it is legal in the current phase.
 *
 *  - `QUOTE_START`    — a quote fetch began. Bumps `quoteNonce` (a NEW quote),
 *                       which is what makes a token/amount change start fresh and
 *                       releases any stale double-charge guard.
 *  - `QUOTE_OK`       — a quote landed; carries the display + token amount.
 *  - `QUOTE_FAIL`     — the quote fetch failed; carries the classified error.
 *  - `PAY_REQUESTED`  — the buyer tapped Pay; we're about to open the wallet.
 *  - `PAY_SUBMITTED`  — `payToken` returned a tx hash (broadcast). ARMS the guard.
 *  - `PAY_CONFIRMED`  — the receipt + `PaymentReceived` event are in hand.
 *  - `PAY_FAILED`     — the attempt threw/reverted; carries the classified error.
 *  - `RETRY`          — retry the SAME payment after a `failed`/`quote_error`.
 *                       Idempotent: keeps `quoteNonce`, returns to a re-quote.
 *  - `RESET_IDLE`     — drop to idle (e.g. wallet disconnected).
 */
export type CheckoutEvent =
  | { type: 'QUOTE_START' }
  | { type: 'QUOTE_OK'; display: string; tokenAmount: bigint }
  | { type: 'QUOTE_FAIL'; error: PayError }
  | { type: 'PAY_REQUESTED' }
  | { type: 'PAY_SUBMITTED'; txHash: Hash }
  | { type: 'PAY_CONFIRMED'; receipt: PaymentReceivedEvent }
  | { type: 'PAY_FAILED'; error: PayError }
  | { type: 'RETRY' }
  | { type: 'RESET_IDLE' }

/**
 * The pure transition function. Given the current state and an event, returns the
 * next state. ILLEGAL transitions are NO-OPS (the same state is returned) rather
 * than throwing — a stray late event from a cancelled effect must never crash the
 * checkout or, worse, move it backward out of a terminal state. The two safety
 * invariants this enforces:
 *
 *   1. **No double charge.** Once `phase === 'pending'` with a `txHash`, a second
 *      `PAY_REQUESTED` is ignored — a buyer mashing Pay, or a retry firing while
 *      the first tx is still in the mempool, cannot broadcast twice.
 *   2. **Terminal is terminal (until reset).** A `confirmed` state ignores every
 *      event except an explicit new `QUOTE_START`/`RESET_IDLE`, so a stale
 *      `PAY_FAILED` from a superseded attempt can't un-confirm a paid order.
 */
export function checkoutReducer(state: CheckoutState, event: CheckoutEvent): CheckoutState {
  switch (event.type) {
    case 'QUOTE_START':
      // A genuinely new quote. Always legal (it supersedes whatever came before),
      // EXCEPT we never silently discard a confirmed payment — re-quoting after a
      // confirmed receipt is an intentional "pay again" and is allowed, but only
      // via this explicit event, never as a side effect of a late callback.
      return {
        ...initialCheckoutState,
        phase: 'quoting',
        quoteNonce: state.quoteNonce + 1,
      }

    case 'QUOTE_OK':
      // Only adopt a quote while we're actively quoting; ignore a late resolve
      // that arrives after the buyer already moved on (e.g. started paying).
      if (state.phase !== 'quoting') return state
      return {
        ...state,
        phase: 'quoted',
        quoteDisplay: event.display,
        quoteTokenAmount: event.tokenAmount,
        error: null,
      }

    case 'QUOTE_FAIL':
      if (state.phase !== 'quoting') return state
      return {
        ...state,
        phase: 'quote_error',
        quoteDisplay: null,
        quoteTokenAmount: null,
        error: event.error,
      }

    case 'PAY_REQUESTED':
      // The double-charge gate: a payment may BEGIN only from a held quote. If a
      // tx is already in flight (pending) or already broadcast for this quote
      // (txHash set), or the wallet popup is already open (awaiting_signature),
      // ignore the click entirely.
      if (state.phase !== 'quoted') return state
      if (state.txHash !== null) return state
      return { ...state, phase: 'awaiting_signature', error: null }

    case 'PAY_SUBMITTED':
      // Broadcast landed. Arm the guard with the tx hash and enter pending.
      // Legal only out of awaiting_signature; a duplicate submit is ignored.
      if (state.phase !== 'awaiting_signature') return state
      return { ...state, phase: 'pending', txHash: event.txHash }

    case 'PAY_CONFIRMED':
      // The receipt is in. Accept from pending (normal) and, defensively, from
      // awaiting_signature in case a fast wallet returns the receipt before we
      // observe the hash. Never from a terminal state.
      if (state.phase !== 'pending' && state.phase !== 'awaiting_signature') return state
      return { ...state, phase: 'confirmed', receipt: event.receipt, error: null }

    case 'PAY_FAILED':
      // A failure during signing/broadcast/mining. Disarm the guard (clear the
      // hash) and surface the classified error. Ignored from terminal/confirmed
      // so a superseded attempt can't overwrite a real success.
      if (state.phase !== 'awaiting_signature' && state.phase !== 'pending') return state
      return { ...state, phase: 'failed', error: event.error, txHash: null }

    case 'RETRY':
      // Idempotent retry of the SAME payment. From a failed/quote_error state we
      // go back to quoting WITHOUT bumping the nonce — the buyer is retrying one
      // payment, and the re-quote refreshes the price (so an underpaid/stale
      // retry is correct, not a replay of the old amount). The guard is released
      // (txHash already cleared by PAY_FAILED). Ignored elsewhere.
      if (state.phase !== 'failed' && state.phase !== 'quote_error') return state
      return {
        ...state,
        phase: 'quoting',
        quoteDisplay: null,
        quoteTokenAmount: null,
        txHash: null,
        error: null,
        receipt: null,
      }

    case 'RESET_IDLE':
      // Hard reset to idle, preserving the nonce so any in-flight effect tied to
      // the old nonce is recognizably stale. Used when the wallet disconnects.
      return { ...initialCheckoutState, quoteNonce: state.quoteNonce }

    default:
      return state
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived selectors (pure helpers the UI reads — no logic duplicated in the view)
// ─────────────────────────────────────────────────────────────────────────────

/** True while any quote/pay effect is in flight (drives spinners + disables Pay). */
export function isBusy(state: CheckoutState): boolean {
  return (
    state.phase === 'quoting' ||
    state.phase === 'awaiting_signature' ||
    state.phase === 'pending'
  )
}

/**
 * True only when a payment may legitimately BEGIN: a fresh quote is held and no
 * tx is in flight. This is the single predicate the Pay button's `disabled` reads
 * for the tx-lifecycle dimension (the component ANDs it with its own gates —
 * merchant active, World ID, buyer tier).
 */
export function canPay(state: CheckoutState): boolean {
  return state.phase === 'quoted' && state.txHash === null
}

/** True when the current state offers a retry of the same payment to the buyer. */
export function canRetry(state: CheckoutState): boolean {
  if (state.phase === 'quote_error') return true
  if (state.phase === 'failed') return state.error?.retryable ?? false
  return false
}

/**
 * The label for the Pay button per phase — single source of truth so the button
 * copy can never drift from the actual lifecycle state (the old code showed
 * "Confirming…" for everything from popup-open to mined).
 */
export function payButtonLabel(state: CheckoutState, fallback: string): string {
  switch (state.phase) {
    case 'quoting':
      return 'Fetching live quote…'
    case 'awaiting_signature':
      return 'Confirm in your wallet…'
    case 'pending':
      return 'Settling on-chain…'
    default:
      return fallback
  }
}

/** A short, buyer-readable status line describing the current phase, or null when silent. */
export function statusLine(state: CheckoutState): { text: string; tone: 'info' | 'error' | 'success' } | null {
  switch (state.phase) {
    case 'awaiting_signature':
      return { text: 'Open your wallet and confirm the payment.', tone: 'info' }
    case 'pending':
      return { text: 'Payment broadcast — waiting for the network to confirm…', tone: 'info' }
    case 'quote_error':
    case 'failed':
      return state.error ? { text: state.error.message, tone: 'error' } : null
    case 'confirmed':
      return { text: 'Payment confirmed.', tone: 'success' }
    default:
      return null
  }
}

/**
 * Stamp the in-flight tx hash, exported for tests + telemetry. Returns the tx
 * hash that the double-charge guard is currently keyed on, or null when no
 * payment is in flight. Kept as a named selector (not an inline field read) so
 * the "the guard is keyed on the tx hash" contract is explicit and greppable.
 */
export function inFlightTxHash(state: CheckoutState): Hash | null {
  return state.phase === 'pending' ? state.txHash : null
}

/** Re-exported so callers can import the tx-hash type alongside the state types. */
export type { Hash }
