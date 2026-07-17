/**
 * @file onchain-svg-simulator.test.tsx — the simulator View renders every
 * state deterministically (SSR string assertions, the NetworkBadge idiom),
 * and the pure display derivations pick the regime-appropriate figures and
 * never invent a cost when a live rate is missing (law #4).
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildReport } from '../lib/onchain-svg/report'
import {
  OnChainSvgSimulatorView,
  SimulatorResult,
  deriveRows,
  formatNativeWei,
  formatUsd8,
  regimeLabel,
  type SimulatorReport,
} from '../components/OnChainSvgSimulator'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#0AF"/></svg>'

/** A canned full report: the real pure math + a synthetic live half. */
function report(live?: Partial<SimulatorReport['live']>): SimulatorReport {
  return {
    ...buildReport(SVG),
    live: {
      chainId: 84532,
      selfSendGas: '28000',
      gasPriceWei: '1000000000', // 1 gwei
      weiPerUsd: '500000000000000', // $1 buys 5e14 wei → native at $2,000
      regime: 'eip7623',
      errors: [],
      ...live,
    },
  }
}

const viewProps = {
  chainId: 84532,
  chains: [{ id: 84532, name: 'Base Sepolia' }],
  onChainChange: () => {},
  onFile: () => {},
}

describe('OnChainSvgSimulatorView — every state is SSR-honest', () => {
  it('renders the idle upload state', () => {
    const html = renderToStaticMarkup(
      createElement(OnChainSvgSimulatorView, { ...viewProps, state: { phase: 'idle' } }),
    )
    expect(html).toContain('data-onchain-sim="idle"')
    expect(html).toContain('Nothing is broadcast')
  })

  it('surfaces a working note and an error message', () => {
    const working = renderToStaticMarkup(
      createElement(OnChainSvgSimulatorView, {
        ...viewProps,
        state: { phase: 'working', note: 'Running the math…' },
      }),
    )
    expect(working).toContain('data-testid="sim-working"')
    const error = renderToStaticMarkup(
      createElement(OnChainSvgSimulatorView, {
        ...viewProps,
        state: { phase: 'error', message: 'Logo SVG is empty.' },
      }),
    )
    expect(error).toContain('Logo SVG is empty.')
  })

  it('renders the full result with all four strategies and the live answer', () => {
    const html = renderToStaticMarkup(
      createElement(OnChainSvgSimulatorView, {
        ...viewProps,
        state: { phase: 'done', report: report() },
      }),
    )
    expect(html).toContain('data-onchain-sim="done"')
    expect(html).toContain('data-testid="sim-strategy-calldata-anchor"')
    expect(html).toContain('data-testid="sim-strategy-sstore2"')
    expect(html).toContain('data-testid="sim-strategy-tokenuri-mint"')
    expect(html).toContain('data-testid="sim-strategy-storage-slots"')
    expect(html).toContain('the live node says it would have used')
    expect(html).toContain('EIP-7623 floor pricing')
  })

  it('stays honest when the live node was unreachable', () => {
    const html = renderToStaticMarkup(
      createElement(SimulatorResult, {
        report: report({ selfSendGas: null, gasPriceWei: null, weiPerUsd: null, regime: null, errors: ['rpc down'] }),
      }),
    )
    expect(html).toContain('could not be reached')
    expect(html).toContain('rpc down')
    expect(html).toContain('Live check unavailable — showing the pure math')
  })
})

describe('deriveRows — regime-appropriate figures, no invented costs', () => {
  it('uses the floor totals when the live node proved EIP-7623', () => {
    const r = report({ regime: 'eip7623' })
    const rows = deriveRows(r)
    for (const [i, row] of rows.entries()) {
      expect(row.gas).toBe(r.strategies[i].gasFloor)
    }
  })

  it('uses the legacy totals otherwise, noting the alternative when it differs', () => {
    const r = report({ regime: 'legacy' })
    const rows = deriveRows(r)
    for (const [i, row] of rows.entries()) {
      expect(row.gas).toBe(r.strategies[i].gasLegacy)
      if (r.strategies[i].gasFloor !== r.strategies[i].gasLegacy) {
        expect(row.altGas).toBe(r.strategies[i].gasFloor)
      }
    }
  })

  it('leaves native/USD costs null when the live rates are missing', () => {
    const rows = deriveRows(report({ gasPriceWei: null, weiPerUsd: null }))
    for (const row of rows) {
      expect(row.nativeCost).toBeNull()
      expect(row.usdCost).toBeNull()
    }
  })

  it('prices gas at the live rates when present (hand computation)', () => {
    // anchor row gas × 1 gwei → wei; at 5e14 wei/$1 → dollars.
    const r = report({ regime: 'legacy' })
    const anchor = deriveRows(r).find((x) => x.strategy === 'calldata-anchor')
    expect(anchor).toBeDefined()
    const wei = BigInt(anchor!.gas) * 1_000_000_000n
    expect(anchor!.nativeCost).toBe(formatNativeWei(wei))
    expect(anchor!.usdCost).toBe(formatUsd8((wei * 100_000_000n) / 500_000_000_000_000n))
  })
})

describe('display formatting — small numbers never round to a lie', () => {
  it('formats sub-cent USD with real precision instead of $0.00', () => {
    expect(formatUsd8(40_000n)).toBe('$0.00040') // 4e4 / 1e8
    expect(formatUsd8(124_000_000n)).toBe('$1.24')
    expect(formatUsd8(0n)).toBe('$0.00')
  })

  it('formats native amounts adaptively', () => {
    expect(formatNativeWei(0n)).toBe('0')
    expect(formatNativeWei(413_000_000_000_000n)).toBe('0.000413')
    expect(formatNativeWei(2_500_000_000_000_000_000n)).toBe('2.5000')
  })

  it('labels every regime without overclaiming', () => {
    expect(regimeLabel('legacy')).toContain('EIP-2028')
    expect(regimeLabel('eip7623')).toContain('EIP-7623')
    expect(regimeLabel('other')).toContain('neither')
    expect(regimeLabel(null)).toContain('unavailable')
  })
})
