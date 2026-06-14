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

describe('AskPage', () => {
  it('renders the AskView without throwing', () => {
    const pageHtml = renderToStaticMarkup(createElement(AskPage))
    expect(pageHtml).toContain('data-testid="ask-view"')
  })
})
