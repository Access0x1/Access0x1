/**
 * @file DocsView.test.tsx — the /docs page mounts the documentation assistant.
 *
 * Runs in the vitest `node` environment via React's static server renderer (the
 * AskView precedent). Proves the page shell renders and surfaces the DocsAssistant
 * chatbox — no network call (the fetch only fires on mount/submit in the browser).
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DocsView } from '../DocsView'
import DocsPage from '../../../app/docs/page'

const html = renderToStaticMarkup(createElement(DocsView))

describe('DocsView renders the docs page', () => {
  it('renders the page shell and the documentation-assistant chatbox', () => {
    expect(html).toContain('data-testid="docs-view"')
    expect(html).toContain('data-testid="docs-assistant"')
  })

  it('shows the documentation heading and links back to the app', () => {
    expect(html).toContain('Access0x1 documentation assistant')
    expect(html).toContain('href="/onboard"')
  })
})

describe('DocsPage', () => {
  it('renders the DocsView without throwing', () => {
    const pageHtml = renderToStaticMarkup(createElement(DocsPage))
    expect(pageHtml).toContain('data-testid="docs-view"')
  })
})
