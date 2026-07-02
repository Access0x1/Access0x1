/**
 * @file AskAssistant.test.tsx — the floating "Ask Access0x1" widget is
 * capability-gated (fail-soft).
 *
 * Runs in the vitest `node` environment via React's static server renderer (the
 * FundButton / AskView precedent). Pins the fail-soft contract: the widget
 * renders NOTHING until the server confirms the assistant is configured
 * (GET /api/ask -> { configured: true }), so an unconfigured deployment never
 * shows a dead button that errors on click. The mount probe is a browser
 * effect; the `initialConfigured` prop is the SSR/test seam that stands in for
 * its result here.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AskAssistant } from '../AskAssistant'

describe('AskAssistant fail-soft capability gate', () => {
  it('renders NOTHING before the server confirms the assistant is configured', () => {
    expect(renderToStaticMarkup(createElement(AskAssistant))).toBe('')
  })

  it('renders NOTHING when the deployment is explicitly unconfigured', () => {
    expect(
      renderToStaticMarkup(createElement(AskAssistant, { initialConfigured: false })),
    ).toBe('')
  })

  it('renders the launcher button once the capability is confirmed', () => {
    const html = renderToStaticMarkup(createElement(AskAssistant, { initialConfigured: true }))
    expect(html).toContain('Ask Access0x1')
    expect(html).toContain('<button')
  })
})
