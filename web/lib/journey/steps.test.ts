/**
 * @file steps.test.ts — the ordering law is the product: steps unlock
 * strictly in sequence, completion never gets invented from junk storage, and
 * progress counts only what is actually done.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_RECORD,
  JOURNEY_ORDER,
  deriveJourney,
  journeyProgress,
  journeyStorageKey,
  parseJourneyRecord,
  type JourneyFacts,
} from './steps'

function facts(overrides: Partial<JourneyFacts> = {}): JourneyFacts {
  return {
    hasWallet: false,
    merchantId: null,
    planSet: false,
    invoiceCreated: false,
    giftCardIssued: false,
    artworkSimulated: false,
    ...overrides,
  }
}

describe('deriveJourney — strict order, honest locks', () => {
  it('starts with only "connect" ready and everything else locked', () => {
    const steps = deriveJourney(facts())
    expect(steps.map((s) => s.status)).toEqual([
      'ready',
      'locked',
      'locked',
      'locked',
      'locked',
      'locked',
      'locked',
    ])
    expect(steps[1].lockedReason).toContain('Connect your wallet')
  })

  it('unlocks exactly one next step as each fact lands', () => {
    let steps = deriveJourney(facts({ hasWallet: true }))
    expect(steps[0].status).toBe('done')
    expect(steps[1].status).toBe('ready')
    expect(steps[2].status).toBe('locked')

    steps = deriveJourney(facts({ hasWallet: true, merchantId: 7n }))
    expect(steps[1].status).toBe('done')
    expect(steps[2].status).toBe('ready')
    expect(steps[3].status).toBe('locked')
    expect(steps[3].lockedReason).toContain('Price a product')
  })

  it('completes the full journey in order', () => {
    const steps = deriveJourney(
      facts({
        hasWallet: true,
        merchantId: 7n,
        planSet: true,
        invoiceCreated: true,
        giftCardIssued: true,
        artworkSimulated: true,
      }),
    )
    expect(steps.every((s) => s.status === 'done')).toBe(true)
    expect(journeyProgress(steps)).toBe(100)
  })

  it('keeps a done step done even when a later fact is missing', () => {
    const steps = deriveJourney(facts({ hasWallet: true, merchantId: 7n, planSet: true }))
    expect(steps[2].status).toBe('done')
    expect(steps[3].status).toBe('ready') // invoice is next, in order
    expect(steps[4].status).toBe('locked') // gift card waits for the invoice
  })

  it('never reorders — the derived keys always match JOURNEY_ORDER', () => {
    const steps = deriveJourney(facts({ hasWallet: true, merchantId: 1n }))
    expect(steps.map((s) => s.key)).toEqual([...JOURNEY_ORDER])
  })
})

describe('journeyProgress — counts done steps only', () => {
  it('is 0 with nothing done and rounds honestly in between', () => {
    expect(journeyProgress(deriveJourney(facts()))).toBe(0)
    // wallet + register done = 2 of 7 ≈ 29%.
    expect(journeyProgress(deriveJourney(facts({ hasWallet: true, merchantId: 1n })))).toBe(29)
  })
})

describe('parseJourneyRecord — junk in, honest false out', () => {
  it('parses a real record', () => {
    const rec = parseJourneyRecord('{"planSet":true,"invoiceCreated":true,"giftCardIssued":false,"artworkSimulated":false}')
    expect(rec).toEqual({ planSet: true, invoiceCreated: true, giftCardIssued: false, artworkSimulated: false })
  })

  it.each([null, '', 'not json', '[]', '42', '{"planSet":"yes"}'])(
    'degrades %j to the empty record instead of inventing completion',
    (raw) => {
      expect(parseJourneyRecord(raw as string | null)).toEqual(EMPTY_RECORD)
    },
  )

  it('scopes the storage key per chain AND per merchant', () => {
    expect(journeyStorageKey(84532, 7n)).toBe('ax1_journey_84532_7')
    expect(journeyStorageKey(5042002, 7n)).not.toBe(journeyStorageKey(84532, 7n))
  })
})
