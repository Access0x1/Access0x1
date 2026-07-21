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
import { getDictionary } from '../../lib/i18n/get-dictionary'

// Hero copy is now locale-driven; render it with each shipped dictionary so the
// truth-in-copy invariant is enforced in EVERY language, not just English.
const en = getDictionary('en')
const pt = getDictionary('pt')
const render = (dict: typeof en): string =>
  renderToStaticMarkup(createElement(Hero, { hero: dict.hero, cta: dict.cta }))

describe('Hero credibility badge — truth-in-copy (law #4)', () => {
  it('states the substantiated ETHGlobal Hacker Pack credential (every locale)', () => {
    expect(render(en)).toContain('ETHGlobal Hacker Pack holder')
    // The credential is named in every locale (pt: "…do ETHGlobal Hacker Pack").
    expect(render(pt)).toContain('ETHGlobal Hacker Pack')
  })

  it('makes no unsubstantiated prize/award claim in any locale', () => {
    for (const dict of [en, pt]) {
      const lower = render(dict).toLowerCase()
      // The repo backs the Hacker Pack (an on-chain token) and nothing else.
      // Any "prize"/"winner"/"award" boast would be an over-claim — in any language.
      expect(lower).not.toContain('prize')
      expect(lower).not.toContain('winner')
      expect(lower).not.toContain('award')
    }
  })
})
