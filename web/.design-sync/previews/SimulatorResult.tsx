import { SimulatorResult } from '@access0x1/web'
import { buildReport } from '@/lib/onchain-svg/report'

// Real pure math via the app's own buildReport (lib/onchain-svg/report.ts) —
// the same fixture shape __tests__/onchain-svg-simulator.test.tsx runs. The
// `live` half mirrors what /api/onchain-estimate returns for a real
// eth_estimateGas cross-check; the second cell mirrors the test's "live node
// unreachable" case — the honest fail-soft fallback to pure math only.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#0AF"/><path d="M20 34l8 8 16-16" stroke="#fff" stroke-width="5" fill="none"/></svg>'

export const LiveCrossCheck = () => (
  <div style={{ maxWidth: 640 }}>
    <SimulatorResult
      report={{
        ...buildReport(SVG),
        live: {
          chainId: 84532,
          selfSendGas: '28214',
          gasPriceWei: '1000000000',
          weiPerUsd: '500000000000000',
          regime: 'eip7623',
          errors: [],
        },
      }}
    />
  </div>
)

export const LiveNodeUnreachable = () => (
  <div style={{ maxWidth: 640 }}>
    <SimulatorResult
      report={{
        ...buildReport(SVG),
        live: {
          chainId: 84532,
          selfSendGas: null,
          gasPriceWei: null,
          weiPerUsd: null,
          regime: null,
          errors: ['eth_estimateGas timed out on Base Sepolia'],
        },
      }}
    />
  </div>
)
