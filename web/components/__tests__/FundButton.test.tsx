/**
 * @file FundButton.test.tsx — the funding control is HIDDEN when unconfigured.
 *
 * Runs in the vitest `node` environment via React's static server renderer (the
 * TokenPicker/VerificationLevels precedent). Proves the button:
 *   - renders NOTHING when neither funding seam is configured (the fail-soft,
 *     pre-booth state) — no dead button, no guessed provider (law #4),
 *   - renders NOTHING when a seam is "shown" but its action callback is missing
 *     (belt-and-braces: visibility requires a wired action),
 *   - shows ONLY the bank option when only the on-ramp is configured,
 *   - shows ONLY the one-tap option when only deposit is configured,
 *   - shows BOTH when both are configured.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { FundButton } from '../FundButton'

type Props = Parameters<typeof FundButton>[0]

const render = (props: Props): string =>
  renderToStaticMarkup(createElement(FundButton, props))

const noop = (): void => {}

describe('hidden when unconfigured', () => {
  it('renders nothing when NEITHER seam is configured', () => {
    expect(render({})).toBe('')
    expect(render({ showBank: false, showOneTap: false })).toBe('')
  })

  it('renders nothing when a seam is shown but its action is missing', () => {
    // showBank true but no onFundWithBank ⇒ still hidden (no dead button).
    expect(render({ showBank: true })).toBe('')
    expect(render({ showOneTap: true })).toBe('')
  })
})

describe('shows only the configured option(s)', () => {
  it('only the bank button when only the on-ramp is configured', () => {
    const out = render({ showBank: true, onFundWithBank: noop })
    expect(out).toContain('data-funding="true"')
    expect(out).toContain('data-action="fund-bank"')
    expect(out).toContain('Fund with bank')
    expect(out).not.toContain('data-action="fund-onetap"')
    expect(out).toContain('data-bank="true"')
    expect(out).toContain('data-onetap="false"')
  })

  it('only the one-tap button when only deposit is configured', () => {
    const out = render({ showOneTap: true, onOneTapDeposit: noop })
    expect(out).toContain('data-action="fund-onetap"')
    expect(out).toContain('One-tap deposit')
    expect(out).not.toContain('data-action="fund-bank"')
    expect(out).toContain('data-onetap="true"')
    expect(out).toContain('data-bank="false"')
  })

  it('both buttons when both are configured', () => {
    const out = render({
      showBank: true,
      showOneTap: true,
      onFundWithBank: noop,
      onOneTapDeposit: noop,
    })
    expect(out).toContain('data-action="fund-bank"')
    expect(out).toContain('data-action="fund-onetap"')
    expect(out).toContain('data-bank="true"')
    expect(out).toContain('data-onetap="true"')
  })

  it('disables the buttons while busy and shows an honest note', () => {
    const out = render({
      showBank: true,
      onFundWithBank: noop,
      busy: true,
      note: 'Bank funding is not configured yet.',
    })
    expect(out).toContain('disabled=""')
    expect(out).toContain('Opening…')
    expect(out).toContain('Bank funding is not configured yet.')
  })
})
