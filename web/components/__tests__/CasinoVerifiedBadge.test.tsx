/**
 * CasinoVerifiedBadge.test.tsx — the "Verified Humans Only · World ID" badge
 * (Casino vertical, World prize). Renders via React's static server renderer
 * (the SuperVerifiedBadge / FundButton precedent — node env, no DOM).
 *
 * Pins:
 *   - the badge renders ONLY when verifiedOperator === true AND
 *     checkoutMode === 'verified-human' AND World ID is configured,
 *   - either condition false → the badge does NOT render,
 *   - the unconfigured casino case shows the honest "configure to verify" line
 *     and NEVER the green badge (fail-soft; never fakes it),
 *   - the (truthful) copy is exactly about personhood/uniqueness and explicitly
 *     NOT a licence / age / eligibility claim (law #4),
 *   - the pure `canShowCasinoBadge` gate agrees with the component.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CasinoVerifiedBadge } from '../CasinoVerifiedBadge'
import {
  CASINO_BADGE_DETAIL,
  CASINO_BADGE_TITLE,
  CASINO_BADGE_UNCONFIGURED,
  canShowCasinoBadge,
} from '@/lib/branding/casinoBadge'

type Props = Parameters<typeof CasinoVerifiedBadge>[0]
const render = (props: Props): string =>
  renderToStaticMarkup(createElement(CasinoVerifiedBadge, props))

describe('badge renders ONLY when BOTH conditions hold + World ID configured', () => {
  it('renders the badge when operator verified + verified-human + configured', () => {
    const out = render({
      verifiedOperator: true,
      checkoutMode: 'verified-human',
      vertical: 'casino',
      worldConfigured: true,
    })
    expect(out).toContain('data-casino-badge="verified"')
    expect(out).toContain(CASINO_BADGE_TITLE)
  })

  it('does NOT render when the operator is not verified', () => {
    const out = render({
      verifiedOperator: false,
      checkoutMode: 'verified-human',
      vertical: 'casino',
      worldConfigured: true,
    })
    expect(out).not.toContain('data-casino-badge="verified"')
  })

  it('does NOT render when the checkout mode is not verified-human', () => {
    for (const checkoutMode of ['standard', 'private'] as const) {
      const out = render({
        verifiedOperator: true,
        checkoutMode,
        vertical: 'casino',
        worldConfigured: true,
      })
      expect(out).not.toContain('data-casino-badge="verified"')
    }
  })
})

describe('fail-soft: unconfigured World ID never fakes the badge', () => {
  it('shows the honest "configure to verify" line for a casino, not the green badge', () => {
    const out = render({
      verifiedOperator: true,
      checkoutMode: 'verified-human',
      vertical: 'casino',
      worldConfigured: false,
    })
    expect(out).not.toContain('data-casino-badge="verified"')
    expect(out).toContain('data-casino-badge="unconfigured"')
    expect(out).toContain(CASINO_BADGE_UNCONFIGURED)
  })

  it('renders nothing for a non-casino merchant whose conditions do not hold', () => {
    const out = render({
      verifiedOperator: false,
      checkoutMode: 'standard',
      vertical: 'standard',
      worldConfigured: true,
    })
    expect(out).toBe('')
  })
})

describe('truth-in-copy (law #4): personhood only, NOT licence/age/eligibility', () => {
  it('the title names World ID and "Verified Humans"', () => {
    expect(CASINO_BADGE_TITLE).toContain('World ID')
    expect(CASINO_BADGE_TITLE.toLowerCase()).toContain('verified humans')
  })

  it('the detail asserts unique personhood and disclaims licence/age/eligibility', () => {
    const lower = CASINO_BADGE_DETAIL.toLowerCase()
    // What World ID DOES prove.
    expect(lower).toContain('unique')
    expect(lower).toContain('proof-of-personhood')
    expect(lower).toContain('one account per person')
    // What it must NOT be read as.
    expect(lower).toContain('not a gambling licence')
    expect(lower).toContain('age')
    expect(lower).toContain('eligibility')
    // No accidental over-claims.
    expect(lower).not.toContain('licensed casino')
    expect(lower).not.toContain('age-verified')
  })
})

describe('canShowCasinoBadge agrees with the component', () => {
  it('true only when all three hold', () => {
    expect(
      canShowCasinoBadge({ verifiedOperator: true, checkoutMode: 'verified-human' }, true),
    ).toBe(true)
    expect(
      canShowCasinoBadge({ verifiedOperator: false, checkoutMode: 'verified-human' }, true),
    ).toBe(false)
    expect(
      canShowCasinoBadge({ verifiedOperator: true, checkoutMode: 'standard' }, true),
    ).toBe(false)
    expect(
      canShowCasinoBadge({ verifiedOperator: true, checkoutMode: 'verified-human' }, false),
    ).toBe(false)
  })
})
