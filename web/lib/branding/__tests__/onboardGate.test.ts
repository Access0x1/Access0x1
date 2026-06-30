/**
 * @file onboardGate.test.ts — the onboard shell connect-gate decision.
 *
 * DISCONNECTED → single hero connect-gate (showCards=false). CONNECTED → the
 * three configuration cards (showCards=true). Fail-soft: an unset/undefined
 * wallet (Dynamic unconfigured) stays on the connect-gate, never throws.
 */
import { describe, expect, it } from 'vitest'
import { showOnboardCards } from '../onboardGate'

describe('showOnboardCards', () => {
  it('false (connect-gate) when no wallet is connected', () => {
    expect(showOnboardCards(null)).toBe(false)
    expect(showOnboardCards(undefined)).toBe(false)
  })

  it('true (show cards) when a wallet object is present', () => {
    expect(showOnboardCards({ address: '0x' + '1'.repeat(40) })).toBe(true)
  })

  it('fail-soft: an undefined wallet (Dynamic unconfigured) stays on the gate', () => {
    // The provider never yields a wallet when Dynamic is unconfigured; the gate
    // is the safe default — no hard-throw.
    expect(showOnboardCards(undefined)).toBe(false)
  })
})
