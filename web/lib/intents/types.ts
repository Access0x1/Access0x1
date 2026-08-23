/**
 * types.ts — the payment-intent domain types + the on-chain orderId bridge.
 *
 * A PaymentIntent is APP-LEVEL state: "a cashier asked a customer for $X".
 * The CHAIN stays the source of payment truth (estate law) — an intent never
 * claims a payment happened; it is the thing a later `PaymentReceived` event
 * (P0.4's watcher) MATCHES AGAINST. That match is the whole reason the
 * bytes32 bridge below is defined here, now, in P0.3: the router's `payToken`
 * carries `orderId: bytes32`, and we fix the canonical encoding before the
 * first intent ever exists so the watcher never faces two conventions.
 *
 * Status here covers only what the intent SERVICE owns: `created` and
 * `expired`. The watcher owns the payment-side states (seen/confirmed/final)
 * and will extend this union in P0.4 — an intent service that could mark
 * things "paid" without a chain event would be a second source of truth,
 * which is the bug this design exists to prevent.
 */
import { ULID_LENGTH, ULID_REGEX } from './ulid.js'

/** The displayed conversion rate at intent-creation time — display evidence,
 *  never settlement math (the chain settles; the snapshot explains). */
export interface QuoteSnapshot {
  /** e.g. "1000098" — the tokenAmount the quote endpoint returned. */
  rate: string
  /** Where the rate came from, e.g. "chainlink:/api/quote". */
  source: string
  /** Unix ms when the snapshot was taken. */
  at: number
}

/** States the intent service itself owns (P0.4's watcher adds the rest). */
export type IntentStatus = 'created' | 'expired'

export interface PaymentIntent {
  /** ULID — 26 chars, time-ordered, unique (see ulid.ts). */
  intentId: string
  /** The verified tenant that created the intent (audit linkage — never public). */
  tenantId: string
  /** The on-chain merchant this sale settles to. */
  merchantId: number
  /** The merchant's checkout slug (drives /c/[slug]?intent=…). */
  slug: string
  /** USD amount × 1e8 — the router's own `usdAmount8` convention. */
  amountUsd8: number
  /** The chain the customer is expected to pay on. */
  chainId: number
  /** Token addresses the customer may pay with; empty = merchant defaults. */
  allowedTokens: readonly string[]
  /** Display-evidence rate snapshot (optional — quotes can be unavailable). */
  quote?: QuoteSnapshot
  status: IntentStatus
  createdAt: number
  expiresAt: number
  /** POS register attribution (flow 2/11 of the POS spec). */
  registerId?: string
  /** Cashier note — private to the merchant, never in the public GET. */
  note?: string
}

/** The fields a CUSTOMER's checkout may see — everything else stays private. */
export interface PublicPaymentIntent {
  intentId: string
  slug: string
  amountUsd8: number
  chainId: number
  allowedTokens: readonly string[]
  quote?: QuoteSnapshot
  status: IntentStatus
  expiresAt: number
}

/** Project an intent onto its public (checkout-safe) shape. */
export function toPublicIntent(intent: PaymentIntent): PublicPaymentIntent {
  const { intentId, slug, amountUsd8, chainId, allowedTokens, quote, status, expiresAt } = intent
  return quote === undefined
    ? { intentId, slug, amountUsd8, chainId, allowedTokens, status, expiresAt }
    : { intentId, slug, amountUsd8, chainId, allowedTokens, quote, status, expiresAt }
}

/**
 * THE CANONICAL orderId ENCODING: the ULID's 26 ascii bytes, right-padded with
 * zero bytes to 32. Chosen over re-encoding the ULID's bits because a human
 * reading an explorer's raw `orderId` hex can literally see the intent id in
 * the ascii column — debuggability is a feature on a money path.
 */
export function intentIdToOrderId(intentId: string): `0x${string}` {
  if (!ULID_REGEX.test(intentId)) {
    throw new Error(`not a canonical ULID: ${intentId.slice(0, 32)}`)
  }
  let hex = ''
  for (let i = 0; i < intentId.length; i++) {
    hex += intentId.charCodeAt(i).toString(16).padStart(2, '0')
  }
  return `0x${hex.padEnd(64, '0')}` as `0x${string}`
}

/**
 * Decode a `payToken` orderId back to its intent id, or null when the bytes
 * are not a canonically-encoded ULID (the watcher treats null as "a payment
 * with no intent attribution" — valid on-chain, just unmatched).
 */
export function orderIdToIntentId(orderId: string): string | null {
  const hex = orderId.startsWith('0x') ? orderId.slice(2) : orderId
  if (hex.length !== 64) return null
  const idHex = hex.slice(0, ULID_LENGTH * 2)
  const padding = hex.slice(ULID_LENGTH * 2)
  if (!/^0*$/.test(padding)) return null
  let out = ''
  for (let i = 0; i < idHex.length; i += 2) {
    const code = parseInt(idHex.slice(i, i + 2), 16)
    if (Number.isNaN(code)) return null
    out += String.fromCharCode(code)
  }
  return ULID_REGEX.test(out) ? out : null
}
