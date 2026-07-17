/**
 * @file journey-ladder.test.tsx — the ordered ladder renders the machine's
 * truth verbatim (SSR string assertions): statuses come straight from
 * deriveJourney, locked steps show their reason and NO body, ready steps
 * mount their body, and the progress meter states the derived number.
 */
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { deriveJourney, journeyProgress, type JourneyFacts } from '../lib/journey/steps'
import { JourneyLadder } from '../components/pages/JourneyView'

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

function render(f: JourneyFacts, body: (key: string) => ReactNode = () => null): string {
  const steps = deriveJourney(f)
  return renderToStaticMarkup(
    createElement(JourneyLadder, {
      steps,
      progress: journeyProgress(steps),
      renderBody: (s) => body(s.key),
    }),
  )
}

describe('JourneyLadder — the ordering law, rendered', () => {
  it('fresh visitor: connect is ready, register is locked with its reason', () => {
    const html = render(facts())
    expect(html).toContain('data-journey-step="connect" data-journey-status="ready"')
    expect(html).toContain('data-journey-step="register" data-journey-status="locked"')
    expect(html).toContain('Connect your wallet')
    expect(html).toContain('the journey runs in order')
    expect(html).toContain('data-journey-progress="0"')
  })

  it('mounts a body ONLY for non-locked steps', () => {
    const html = render(facts({ hasWallet: true }), (key) =>
      createElement('span', { 'data-testid': `body-${key}` }),
    )
    expect(html).toContain('data-testid="body-connect"') // done → summary slot
    expect(html).toContain('data-testid="body-register"') // ready → form slot
    expect(html).not.toContain('data-testid="body-plan"') // locked → nothing
  })

  it('registered merchant: create steps unlock in order, share stays locked', () => {
    const html = render(facts({ hasWallet: true, merchantId: 7n }))
    expect(html).toContain('data-journey-step="plan" data-journey-status="ready"')
    expect(html).toContain('data-journey-step="invoice" data-journey-status="locked"')
    expect(html).toContain('data-journey-step="share" data-journey-status="locked"')
    expect(html).toContain('data-journey-progress="29"')
  })

  it('a finished journey renders every step done at 100%', () => {
    const html = render(
      facts({
        hasWallet: true,
        merchantId: 7n,
        planSet: true,
        invoiceCreated: true,
        giftCardIssued: true,
        artworkSimulated: true,
      }),
    )
    expect(html).not.toContain('data-journey-status="locked"')
    expect(html).not.toContain('data-journey-status="ready"')
    expect(html).toContain('data-journey-progress="100"')
  })
})
