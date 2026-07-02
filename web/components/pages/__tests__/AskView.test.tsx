/**
 * @file AskView.test.tsx — the /ask booth assistant page renders its chat UI.
 *
 * Runs in the vitest `node` environment via React's static server renderer (the
 * FundButton / TokenPicker / VerificationLevels precedent). Proves the page
 * renders the input, the send button, the streamed-answer area, the grounded
 * tagline, and the suggested questions — without any network call (the fetch
 * only fires on submit, which static render never triggers).
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AskView } from '../AskView'
import AskPage from '../../../app/ask/page'

const html = renderToStaticMarkup(createElement(AskView))

describe('AskView renders the chat UI', () => {
  it('renders the question input and the send button', () => {
    expect(html).toContain('id="ask-input"')
    expect(html).toContain('data-action="ask-send"')
    expect(html).toContain('>Ask<')
  })

  it('renders the streamed-answer area', () => {
    expect(html).toContain('data-testid="ask-answer"')
    expect(html).toContain('The answer will stream in here.')
  })

  it('shows the grounded tagline and at least one suggested question', () => {
    expect(html.toLowerCase()).toContain('access0x1')
    expect(html).toContain('What is Access0x1?')
  })

  it('links back to the app', () => {
    expect(html).toContain('href="/onboard"')
  })
})

describe('AskView unconfigured → honest disabled state (fail-soft)', () => {
  // /ask is a routable page, so it cannot vanish like the floating widget —
  // when GET /api/ask reports { configured: false } the form must be DISABLED
  // and the answer area must say so honestly. Never a dead form that errors on
  // send. `initialCapability` is the SSR/test seam for the mount probe result.
  const offHtml = renderToStaticMarkup(
    createElement(AskView, { initialCapability: 'unconfigured' }),
  )

  it('marks the view unconfigured and says so honestly in the answer area', () => {
    expect(offHtml).toContain('data-ask-capability="unconfigured"')
    expect(offHtml).toContain('not configured on this deployment')
    expect(offHtml).not.toContain('The answer will stream in here.')
  })

  it('disables the input and the send button', () => {
    // React renders a disabled control as `disabled=""` in JSX attribute order.
    expect(offHtml).toContain('disabled="" data-action="ask-send"')
    expect(offHtml).toMatch(/<textarea[^>]*disabled=""/)
  })
})

describe('AskPage', () => {
  it('renders the AskView without throwing', () => {
    const pageHtml = renderToStaticMarkup(createElement(AskPage))
    expect(pageHtml).toContain('data-testid="ask-view"')
  })
})
