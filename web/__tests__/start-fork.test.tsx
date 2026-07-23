/**
 * @file start-fork.test.tsx — the /onboard fork chooser + developer panel,
 * pinned as SSR strings (the JourneyLadder / IdentityChipView precedent). Both
 * are pure presentational components, so they render in the vitest `node` env
 * via react-dom/server with no wallet provider. Assertions avoid apostrophes on
 * purpose: the server renderer encodes `'` (e.g. "I&#x27;m"), so we match only
 * apostrophe-free substrings.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { StartFork } from '../components/onboard/StartFork'
import { DeveloperPanel } from '../components/onboard/DeveloperPanel'

const noop = (): void => {}

describe('StartFork — the how-do-you-want-to-start chooser', () => {
  const html = renderToStaticMarkup(createElement(StartFork, { onChoose: noop }))

  it('offers both paths as two tagged cards, get-me-paid as the primary no-code one', () => {
    expect(html).toContain('data-fork-card="merchant"')
    expect(html).toContain('data-fork-card="developer"')
    expect(html).toContain('Just get me paid')
    expect(html).toContain('No wallet jargon, no code')
    expect(html).toContain('No code')
    // The developer path is present, framed as the second choice.
    expect(html).toContain('a developer')
  })

  it('never surfaces the ENS plumbing to the non-technical visitor', () => {
    expect(html).not.toContain('ENS')
    expect(html).not.toContain('.eth')
  })

  it('shows a persistent, address-free help line', () => {
    expect(html).toContain('Questions?')
    expect(html).toContain('href="/docs"')
    // No invented support email anywhere on the chooser.
    expect(html).not.toContain('@')
  })
})

describe('DeveloperPanel — clone / contribute, honest about npm', () => {
  const html = renderToStaticMarkup(createElement(DeveloperPanel, { onBack: noop }))

  it('links the repo and the quickstart', () => {
    expect(html).toContain('href="https://github.com/Access0x1/Access0x1"')
    expect(html).toContain('QUICKSTART.md')
  })

  it('offers the SDK but prefers clone/contribute — and is honest there is no npm package', () => {
    expect(html).toContain('@access0x1/react')
    expect(html).toContain('no npm package')
    expect(html).toContain('clone or contribute')
  })
})
