/**
 * store.ts — the durable payment-intent store (P0.3).
 *
 * Same architecture as every store in the rail (the branding store is the
 * template): a SYNCHRONOUS in-memory hot map is the read surface, and the
 * durable KV (namespace `intents:v1`) is the write-through + boot-hydrate
 * side-channel — so an intent SURVIVES a restart, which is the entire P0
 * point (a customer mid-payment must not lose their QR's meaning because the
 * box restarted).
 *
 * EXPIRY IS LAZY, NOT SCHEDULED: any read past `expiresAt` flips the row to
 * `expired` (durably) before returning it. No cron, no timer to leak, no
 * missed sweep on restart — an intent that nobody ever reads again simply
 * rests as `created` in storage, and the first reader settles its truth.
 * Callers therefore NEVER branch on wall-clock themselves; the store's answer
 * already accounts for time.
 *
 * The service owns only created→expired. Payment-side transitions belong to
 * the P0.4 chain watcher (see types.ts — one source of truth, the chain).
 */
import { durableSet, hydrate } from '../storage/durableKv.js'
import { ulid } from './ulid.js'
import type { PaymentIntent, QuoteSnapshot } from './types.js'

/** The durable-KV namespace for intent rows (key = intentId). */
const KV_NAMESPACE = 'intents:v1'

/** Default intent lifetime: 15 minutes — long enough for a customer fumbling a
 *  wallet, short enough that a stale register QR dies on its own. */
export const DEFAULT_INTENT_TTL_MS = 15 * 60_000

/** Bounds a creator must respect (validated again at the API edge). */
export const MIN_AMOUNT_USD8 = 1 // one hundred-millionth of a dollar — no zero/negative sales
export const MAX_AMOUNT_USD8 = 1_000_000 * 1e8 // $1M cap per single intent
export const MAX_NOTE_CHARS = 200
export const MAX_TTL_MS = 24 * 60 * 60_000 // a day — beyond that it's an invoice, not a POS intent

const intents = new Map<string, PaymentIntent>()

// Boot-hydrate the hot map from the durable copy (restart recovery). Fire-and-
// forget like the sibling stores: a store that cannot hydrate starts empty and
// keeps serving (fail-soft law of the non-security stores).
const hydrated: Promise<number> = hydrate(KV_NAMESPACE, (key, value) => {
  intents.set(key, value as PaymentIntent)
})

/** Await boot hydration where ordering matters (tests; never request paths). */
export function intentsHydrated(): Promise<number> {
  return hydrated
}

export interface CreateIntentInput {
  tenantId: string
  merchantId: number
  slug: string
  amountUsd8: number
  chainId: number
  allowedTokens?: readonly string[]
  quote?: QuoteSnapshot
  registerId?: string
  note?: string
  ttlMs?: number
}

/**
 * Create + durably persist a new intent. Throws on out-of-bounds input — the
 * API edge maps these to 400s; internal callers deserve the loud failure.
 */
export function createIntent(input: CreateIntentInput, nowMs: number = Date.now()): PaymentIntent {
  if (!Number.isInteger(input.amountUsd8) || input.amountUsd8 < MIN_AMOUNT_USD8 || input.amountUsd8 > MAX_AMOUNT_USD8) {
    throw new Error(`amountUsd8 out of bounds: ${input.amountUsd8}`)
  }
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
    throw new Error(`chainId must be a positive integer: ${input.chainId}`)
  }
  if (input.note !== undefined && input.note.length > MAX_NOTE_CHARS) {
    throw new Error(`note exceeds ${MAX_NOTE_CHARS} chars`)
  }
  const ttl = input.ttlMs ?? DEFAULT_INTENT_TTL_MS
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_MS) {
    throw new Error(`ttlMs out of bounds: ${ttl}`)
  }

  const intent: PaymentIntent = {
    intentId: ulid(nowMs),
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    slug: input.slug,
    amountUsd8: input.amountUsd8,
    chainId: input.chainId,
    allowedTokens: input.allowedTokens ?? [],
    ...(input.quote !== undefined ? { quote: input.quote } : {}),
    status: 'created',
    createdAt: nowMs,
    expiresAt: nowMs + ttl,
    ...(input.registerId !== undefined ? { registerId: input.registerId } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  }
  intents.set(intent.intentId, intent)
  durableSet(KV_NAMESPACE, intent.intentId, intent)
  return intent
}

/**
 * Read one intent, settling lazy expiry first: a `created` intent past its
 * `expiresAt` becomes `expired` (persisted) before it is returned.
 */
export function getIntent(intentId: string, nowMs: number = Date.now()): PaymentIntent | undefined {
  const intent = intents.get(intentId)
  if (!intent) return undefined
  if (intent.status === 'created' && nowMs >= intent.expiresAt) {
    const expired: PaymentIntent = { ...intent, status: 'expired' }
    intents.set(intentId, expired)
    durableSet(KV_NAMESPACE, intentId, expired)
    return expired
  }
  return intent
}

/** Test-only: clear the hot map (durable rows are the tests' concern). */
export function __resetIntentsForTests(): void {
  intents.clear()
}
