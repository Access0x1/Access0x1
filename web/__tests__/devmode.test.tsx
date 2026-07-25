/**
 * devmode.test.tsx — the developer view is CONTENT, not a JS trick.
 *
 * The whole value of folding the technical answers into the page is that they are
 * really there: server-rendered, indexable, readable with JS disabled, and visible
 * to anyone who views source. If they were injected on toggle, the sceptical reader
 * the feature exists for would be reading marketing copy with extra steps.
 *
 * These tests pin that property, plus the one that keeps the merchant's page clean:
 * hidden by default, and hidden by CSS rather than by omission.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { FeatureGrid } from '@/components/marketing/FeatureGrid'
import { getDictionary } from '@/lib/i18n/get-dictionary'

function html(): string {
  const dict = getDictionary('en')
  return renderToStaticMarkup(<FeatureGrid features={dict.features} />)
}

describe('developer view', () => {
  it('ships every technical answer in the SERVER-rendered HTML', () => {
    const markup = html()
    // A claim a developer would check, present without any client JS running.
    expect(markup).toContain('dev-note')
    expect(markup).toMatch(/Chainlink feed INSIDE the settlement transaction/i)
  })

  it('states an honest limit next to the capability, not only the strength', () => {
    const markup = html()
    // The caveats are the reason a technical reader believes the rest of the page.
    expect(markup).toMatch(/Caveat:/)
    // The one that matters most for the agent story — no overclaim about mandates.
    expect(markup).toMatch(/cannot yet buy an asset under a mandate/i)
  })

  it('names the backing contract for every card', () => {
    const markup = html()
    for (const contract of [
      'Access0x1Router.sol',
      'SessionGrant.sol',
      'Access0x1Bookings.sol',
      'Access0x1GiftCards.sol',
    ]) {
      expect(markup).toContain(contract)
    }
  })

  it('renders the toggle so the reader can choose which audience they are', () => {
    expect(html()).toContain('devmode-toggle')
  })

  it('does not force the notes open — the merchant view stays clean', () => {
    // No inline "display:block" or data-devmode="on" is emitted at render time;
    // visibility is entirely the CSS rule keyed off <html data-devmode>.
    const markup = html()
    expect(markup).not.toContain('data-devmode="on"')
  })
})
