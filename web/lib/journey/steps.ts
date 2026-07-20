/**
 * steps.ts — the ordered business lifecycle as a PURE state machine.
 *
 * The /journey wizard walks a wallet through what a real business does, in
 * the order a real business does it: connect → register the merchant seat →
 * price a product (subscription plan) → bill a customer (invoice) → reward a
 * customer (gift card) → share the checkout link → put the brand mark
 * on-chain (simulated). Steps unlock STRICTLY in order — the guided journey
 * IS the ordering; the unstructured /contracts console exists for everything
 * else.
 *
 * This module owns only the derivation (facts in → step statuses out) and the
 * localStorage (de)serialization guards, so the ordering law is unit-tested
 * offline with zero React. The container feeds it live facts.
 */

/** The ordered step keys. Order here IS the product order — never resort. */
export const JOURNEY_ORDER = [
  'connect',
  'register',
  'plan',
  'invoice',
  'giftcard',
  'share',
  'artwork',
] as const

export type JourneyStepKey = (typeof JOURNEY_ORDER)[number]

/** Static copy for each step (title + what it really does on-chain). */
export const JOURNEY_STEPS: Record<JourneyStepKey, { title: string; blurb: string }> = {
  connect: {
    title: 'Connect your wallet',
    blurb: 'The wallet IS the business identity — every step below is signed by it.',
  },
  register: {
    title: 'Register your business',
    blurb: 'One permissionless registerMerchant() creates your merchant seat on the shared router. Zero custody — payouts go straight to your wallet.',
  },
  plan: {
    title: 'Price a product',
    blurb: 'Publish a subscription plan (USD price + billing period) with setPlan() — subscribers can then open budget-capped sessions against it.',
  },
  invoice: {
    title: 'Bill a customer',
    blurb: 'Create an on-chain invoice with createInvoice() — anyone (or one named payer) can settle it through the router’s USD-priced fee split.',
  },
  giftcard: {
    title: 'Reward a customer',
    blurb: 'Issue a gift card with issueCard() — a USD-denominated balance keyed to a code only you and the recipient know (only its hash goes on-chain).',
  },
  share: {
    title: 'Share your checkout link',
    blurb: 'Your hosted checkout is live at /m/<your merchant id> — a link, a QR, a one-tag embed. Customers pay; the router splits and settles in the same transaction.',
  },
  artwork: {
    title: 'Your brand, as if on-chain',
    blurb: 'Upload your mark and get a provable estimate of what storing it on-chain would have cost if it just ran — pure EVM math, cross-checked live. Nothing is broadcast.',
  },
}

/** Everything the derivation needs to know — plain facts, no React. */
export interface JourneyFacts {
  hasWallet: boolean
  merchantId: bigint | null
  planSet: boolean
  invoiceCreated: boolean
  giftCardIssued: boolean
  artworkSimulated: boolean
}

export type StepStatus = 'done' | 'ready' | 'locked'

export interface JourneyStep {
  key: JourneyStepKey
  title: string
  blurb: string
  status: StepStatus
  /** Human reason while locked (names the step that must come first). */
  lockedReason: string | null
}

/** Is this step DONE, given the facts? (Order-independent completion truth.) */
function isDone(key: JourneyStepKey, facts: JourneyFacts): boolean {
  switch (key) {
    case 'connect':
      return facts.hasWallet
    case 'register':
      return facts.merchantId !== null
    case 'plan':
      return facts.planSet
    case 'invoice':
      return facts.invoiceCreated
    case 'giftcard':
      return facts.giftCardIssued
    case 'share':
      // Sharing is "done" the moment there is a live link to share.
      return facts.merchantId !== null && facts.planSet && facts.invoiceCreated && facts.giftCardIssued
    case 'artwork':
      return facts.artworkSimulated
  }
}

/**
 * Derive the ordered journey: a step is `ready` only when every step before
 * it is `done` — the strict-order law. Completed steps stay `done` even if a
 * later fact regresses (facts are the truth; the order only gates ENTRY).
 */
export function deriveJourney(facts: JourneyFacts): JourneyStep[] {
  const steps: JourneyStep[] = []
  let allPriorDone = true
  for (const key of JOURNEY_ORDER) {
    const done = isDone(key, facts)
    const status: StepStatus = done ? 'done' : allPriorDone ? 'ready' : 'locked'
    const firstBlocker = steps.find((s) => s.status !== 'done')
    steps.push({
      key,
      title: JOURNEY_STEPS[key].title,
      blurb: JOURNEY_STEPS[key].blurb,
      status,
      lockedReason:
        status === 'locked' && firstBlocker
          ? `Finish “${firstBlocker.title}” first — the journey runs in order.`
          : null,
    })
    allPriorDone = allPriorDone && done
  }
  return steps
}

/** How far along the journey is, for the progress meter (0..100). */
export function journeyProgress(steps: readonly JourneyStep[]): number {
  if (steps.length === 0) return 0
  const done = steps.filter((s) => s.status === 'done').length
  return Math.round((done / steps.length) * 100)
}

/** The per-merchant created-things flags persisted in the browser. */
export interface JourneyRecord {
  planSet: boolean
  invoiceCreated: boolean
  giftCardIssued: boolean
  artworkSimulated: boolean
}

export const EMPTY_RECORD: JourneyRecord = {
  planSet: false,
  invoiceCreated: false,
  giftCardIssued: false,
  artworkSimulated: false,
}

/** The localStorage key for a merchant's journey record on one chain. */
export function journeyStorageKey(chainId: number, merchantId: bigint): string {
  return `ax1_journey_${chainId}_${merchantId.toString()}`
}

/**
 * Parse a stored journey record, tolerating anything: junk, missing keys, or
 * a hand-edited value degrade to `false` flags — the wizard re-offers a step
 * rather than inventing completion (law #4).
 */
export function parseJourneyRecord(raw: string | null): JourneyRecord {
  if (!raw) return { ...EMPTY_RECORD }
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof JourneyRecord, unknown>>
    return {
      planSet: parsed.planSet === true,
      invoiceCreated: parsed.invoiceCreated === true,
      giftCardIssued: parsed.giftCardIssued === true,
      artworkSimulated: parsed.artworkSimulated === true,
    }
  } catch {
    return { ...EMPTY_RECORD }
  }
}
