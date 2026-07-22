/**
 * @file DocsAssistant.test.tsx — the inline documentation-assistant chatbox.
 *
 * Runs in the vitest `node` environment via React's static server renderer (the
 * AskView / FundButton precedent). Proves the card renders its input, send
 * button, streamed-answer area, label, and suggested questions — without any
 * network call (the fetch only fires on submit/mount, which static render never
 * triggers) — and that the fail-soft unconfigured state disables the form and
 * says so honestly. `initialCapability` is the SSR/test seam for the mount probe.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DocsAssistant } from '../DocsAssistant'

describe('DocsAssistant renders the chatbox', () => {
  const html = renderToStaticMarkup(createElement(DocsAssistant, { initialCapability: 'ready' }))

  it('renders the question input and the send button', () => {
    expect(html).toContain('id="docs-input"')
    expect(html).toContain('data-action="docs-send"')
    expect(html).toContain('>Ask<')
  })

  it('renders the streamed-answer area with the idle placeholder', () => {
    expect(html).toContain('data-testid="docs-answer"')
    expect(html).toContain('The answer will stream in here.')
  })

  it('labels itself as the documentation assistant and lists a suggested question', () => {
    expect(html).toContain('Ask the docs')
    expect(html.toLowerCase()).toContain('documentation')
    expect(html).toContain('How do I register a merchant?')
  })

  it('keeps the copy plain — no crypto/NFT/invest marketing words', () => {
    const lower = html.toLowerCase()
    expect(lower).not.toContain('crypto')
    expect(lower).not.toContain('nft')
    expect(lower).not.toContain('invest')
  })
})

describe('DocsAssistant unconfigured → honest disabled state (fail-soft)', () => {
  const offHtml = renderToStaticMarkup(
    createElement(DocsAssistant, { initialCapability: 'unconfigured' }),
  )

  it('marks the card unconfigured and says so honestly in the answer area', () => {
    expect(offHtml).toContain('data-docs-capability="unconfigured"')
    expect(offHtml).toContain('not configured on this deployment')
    expect(offHtml).not.toContain('The answer will stream in here.')
  })

  it('disables the input so it can never dead-click', () => {
    expect(offHtml).toMatch(/<textarea[^>]*disabled=""/)
  })
})
