/**
 * @file token-picker.test.tsx — the buyer pay-token picker renders honestly.
 *
 * Runs in the vitest `node` environment via React's static server renderer (the
 * VerificationLevels precedent). Proves the picker:
 *   - lists every supported coin (USDC default first),
 *   - marks the selected coin checked,
 *   - shows an UNCONFIGURED coin DISABLED with an honest "not available on this
 *     chain" note (never hidden, never a guessed address — law #4 / guardrail #5),
 *   - keeps an available coin enabled + clickable.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TokenPicker } from '../components/TokenPicker'
import type { PayTokenSymbol, ResolvedPayToken } from '../lib/tokens.js'
import { SUPPORTED_PAY_TOKENS } from '../lib/tokens.js'

const ADDR = ('0x' + '11'.repeat(20)) as `0x${string}`

/** Build a resolved set where the named symbols are available, the rest are not. */
function resolved(available: PayTokenSymbol[]): ResolvedPayToken[] {
  return SUPPORTED_PAY_TOKENS.map((meta) => {
    const isAvail = available.includes(meta.symbol)
    return {
      ...meta,
      address: isAvail ? ADDR : undefined,
      feed: isAvail ? ADDR : undefined,
      available: isAvail,
    }
  })
}

const render = (
  tokens: ResolvedPayToken[],
  selected: PayTokenSymbol,
  disabled = false,
): string =>
  renderToStaticMarkup(
    createElement(TokenPicker, { tokens, selected, onSelect: () => {}, disabled }),
  )

/** Extract the single `<button …>` opening tag for a given coin (attr order is JSX-fixed). */
function buttonTag(html: string, symbol: PayTokenSymbol): string {
  const m = html.match(new RegExp(`<button[^>]*data-symbol="${symbol}"[^>]*>`))
  return m ? m[0] : ''
}

describe('TokenPicker renders the full menu', () => {
  it('lists every supported coin', () => {
    const out = render(resolved(['USDC']), 'USDC')
    for (const t of SUPPORTED_PAY_TOKENS) {
      expect(out).toContain(t.symbol)
      expect(out).toContain(t.name)
    }
  })

  it('marks the selected coin checked (USDC default)', () => {
    const out = render(resolved(['USDC', 'LINK']), 'USDC')
    // The USDC radio is checked; its row shows "Selected".
    expect(buttonTag(out, 'USDC')).toContain('aria-checked="true"')
    expect(out).toContain('Selected')
  })

  it('selecting a different coin moves the checked state', () => {
    const out = render(resolved(['USDC', 'LINK']), 'LINK')
    expect(buttonTag(out, 'LINK')).toContain('aria-checked="true"')
    expect(buttonTag(out, 'USDC')).toContain('aria-checked="false"')
  })
})

describe('honest availability', () => {
  it('an unconfigured coin is disabled + labelled "not available on this chain"', () => {
    const out = render(resolved(['USDC']), 'USDC')
    // LINK is not configured here → disabled with the honest note.
    expect(buttonTag(out, 'LINK')).toContain('disabled=""')
    expect(buttonTag(out, 'LINK')).toContain('data-available="false"')
    expect(out).toContain('not available on this chain')
  })

  it('an available coin is NOT disabled and carries no unavailable note', () => {
    const out = render(resolved(['USDC', 'WETH']), 'USDC')
    const weth = buttonTag(out, 'WETH')
    // WETH is configured → enabled: no boolean `disabled` attr, aria-disabled false.
    expect(weth).toContain('data-available="true"')
    expect(weth).not.toContain('disabled=""')
    expect(weth).toContain('aria-disabled="false"')
  })

  it('when the whole picker is disabled (paying), even available coins are locked', () => {
    const out = render(resolved(['USDC', 'WETH']), 'USDC', true)
    expect(buttonTag(out, 'WETH')).toContain('disabled=""')
    expect(buttonTag(out, 'USDC')).toContain('disabled=""')
  })
})
