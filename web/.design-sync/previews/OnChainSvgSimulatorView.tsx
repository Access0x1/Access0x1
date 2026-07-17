import { OnChainSvgSimulatorView } from '@access0x1/web'
import { SUPPORTED_CHAINS, getDefaultChainId } from '@/lib/chains'
import { buildReport } from '@/lib/onchain-svg/report'

// Pure presentational component — its four states are exactly the SimState
// union (components/OnChainSvgSimulator.tsx), the same states __tests__/
// onchain-svg-simulator.test.tsx exercises via renderToStaticMarkup. `chains`
// is built the same way the real container builds it: SUPPORTED_CHAINS
// (lib/chains.ts) mapped to {id, name}.
const chains = SUPPORTED_CHAINS.map((c) => ({ id: c.id, name: c.name }))
const chainId = getDefaultChainId()
const noop = () => {}

export const Idle = () => (
  <OnChainSvgSimulatorView state={{ phase: 'idle' }} chainId={chainId} chains={chains} onChainChange={noop} onFile={noop} />
)

export const Working = () => (
  <OnChainSvgSimulatorView
    state={{ phase: 'working', note: 'Running the math + asking the live node…' }}
    chainId={chainId}
    chains={chains}
    onChainChange={noop}
    onFile={noop}
  />
)

export const UploadError = () => (
  <OnChainSvgSimulatorView
    state={{ phase: 'error', message: 'Logo SVG is empty.' }}
    chainId={chainId}
    chains={chains}
    onChainChange={noop}
    onFile={noop}
  />
)

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#0AF"/><path d="M20 34l8 8 16-16" stroke="#fff" stroke-width="5" fill="none"/></svg>'

export const Done = () => (
  <OnChainSvgSimulatorView
    state={{
      phase: 'done',
      report: {
        ...buildReport(SVG),
        live: {
          chainId: 84532,
          selfSendGas: '28214',
          gasPriceWei: '1000000000',
          weiPerUsd: '500000000000000',
          regime: 'eip7623',
          errors: [],
        },
      },
    }}
    chainId={84532}
    chains={chains}
    onChainChange={noop}
    onFile={noop}
  />
)
