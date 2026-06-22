/**
 * IntegrationStrip.tsx — the "works with" trust strip on the landing page.
 *
 * A static, server-renderable row of partner badges showing what Access0x1 is
 * built on: Chainlink (USD price feeds + Automation), and the chains it settles
 * to — Arc, Base, and zkSync testnets. It is a credibility cue, so each badge
 * is a plain label (no external logo request) styled with the existing shadcn
 * `Badge` primitive and brand tokens. No client JS.
 *
 * The data is a const list; adding a chain later is a one-line edit here, not a
 * layout change.
 */
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'

/** One integration chip: the partner name + what it provides. */
interface Integration {
  /** Display name of the partner / chain. */
  name: string
  /** Short note on the role it plays — shown as the chip's title (tooltip). */
  role: string
}

/**
 * The integration set. Chainlink first (the oracle + automation backbone the
 * pitch leans on), then the settlement chains in build-order priority.
 */
const INTEGRATIONS: readonly Integration[] = [
  { name: 'Chainlink', role: 'USD price feeds + Automation keepers' },
  { name: 'Arc', role: 'USDC-native settlement chain (chain id 5042002)' },
  { name: 'Base', role: 'Low-cost L2 settlement' },
  { name: 'zkSync', role: 'ZK-rollup settlement' },
]

export function IntegrationStrip(): ReactNode {
  return (
    <section className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex flex-col items-center gap-6 rounded-2xl border border-border bg-card/50 px-6 py-8">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Powered by, and live on
        </p>

        <ul className="flex flex-wrap items-center justify-center gap-3">
          {INTEGRATIONS.map((integration) => (
            <li key={integration.name}>
              <Badge
                variant="secondary"
                title={integration.role}
                className="px-4 py-1.5 text-sm"
              >
                {integration.name}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export default IntegrationStrip
