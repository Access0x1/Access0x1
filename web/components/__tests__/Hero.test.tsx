/**
 * Hero.test.tsx — truth-in-copy guard for the public landing hero (law #4).
 *
 * The hero's credibility badge may state ONLY what the repo can substantiate:
 * the ETHGlobal Hacker Pack is an on-chain credential (EG-HACKER, balance 1 on
 * Optimism — see README.md line 9). No other award/prize claim is backed by the
 * repo, so none may appear here. This test pins that invariant so an
 * unsubstantiated boast (e.g. a "prize winner" line) cannot creep back into the
 * top fold of a PUBLIC marketing page.
 *
 * Rendered via React's static server renderer (the CasinoVerifiedBadge
 * precedent — node env, no DOM); Hero is a pure server component (no hooks).
 *
 * (Lives in components/__tests__/ — NOT under components/marketing/ — because a
 * bare `marketing/` entry in the repo .gitignore would silently exclude a test
 * file placed there.)
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Hero } from '../marketing/Hero'

const render = (): string => renderToStaticMarkup(createElement(Hero))

describe('Hero credibility badge — truth-in-copy (law #4)', () => {
  it('states the substantiated ETHGlobal Hacker Pack credential', () => {
    const out = render()
    expect(out).toContain('ETHGlobal Hacker Pack holder')
  })

  it('makes no unsubstantiated prize/award claim', () => {
    const lower = render().toLowerCase()
    // The repo backs the Hacker Pack (an on-chain token) and nothing else.
    // Any "prize"/"winner"/"award" boast would be an over-claim on a public page.
    expect(lower).not.toContain('prize')
    expect(lower).not.toContain('winner')
    expect(lower).not.toContain('award')
  })
})
