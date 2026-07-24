/**
 * IntegrationStrip.tsx — the "works with" trust strip on the landing page.
 *
 * Chainlink (USD price feeds + Automation) + the chains the shared mirror router
 * is actually live on. The "live on" set is NOT hand-listed: it's derived from
 * the GENERATED deploy table (lib/deployments.ts, built from the committed
 * broadcasts by gen-deployments), filtered to the chains that carry the mirror
 * router. So the strip can never claim a chain that isn't on-chain — the repo's
 * "an address that isn't on-chain isn't claimed" law, enforced at render time.
 * A chain is added by deploying it (it appears in DEPLOYMENTS) + giving it a
 * short label below; remove a deploy and it disappears here automatically.
 *
 * The heading + the known chains' role tooltips are localized (dict.integrations).
 */
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { CalcadaMedallion } from '@/components/marketing/Calcada'
import { DEPLOYMENTS } from '@/lib/deployments'
import type { Dictionary } from '@/lib/i18n/get-dictionary'

/** The CREATE3 mirror router — one deterministic address on every mirror chain. */
const MIRROR_ROUTER = '0xe92244e3368561faf21648146511dede3a475eb5'

/**
 * Short display labels, in display order. A chain renders ONLY when the
 * generated DEPLOYMENTS proves the mirror router is deployed on it (below), so
 * this map is cosmetic — it can widen an honest claim, never fabricate one.
 */
const CHAIN_LABELS: ReadonlyArray<readonly [number, string]> = [
  [5042002, 'Arc'],
  [84532, 'Base'],
  [11155111, 'Ethereum'],
  [11155420, 'Optimism'],
  [43113, 'Avalanche Fuji'],
  [46630, 'Robinhood'],
  [421614, 'Arbitrum'],
  [11142220, 'Celo'],
  [300, 'zkSync'],
]

/** Chain ids that actually carry the mirror router, from the generated table. */
const MIRROR_CHAIN_IDS = new Set(
  DEPLOYMENTS.filter((c) =>
    c.deployments.some((d) => d.address.toLowerCase() === MIRROR_ROUTER),
  ).map((c) => c.chainId),
)

/** The live "on" labels — only chains present in BOTH the label map and the deploy table. */
const LIVE_CHAINS: string[] = CHAIN_LABELS.filter(([id]) => MIRROR_CHAIN_IDS.has(id)).map(
  ([, label]) => label,
)

export interface IntegrationStripProps {
  integrations: Dictionary['integrations']
}

export function IntegrationStrip({ integrations }: IntegrationStripProps): ReactNode {
  const roles = integrations.roles as Record<string, string | undefined>
  const items = ['Chainlink', ...LIVE_CHAINS]

  return (
    <section className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex flex-col items-center gap-6 rounded-2xl border border-border bg-card/50 px-6 py-8">
        {/* The brand glyph as a calçada roundel — the logo, set in stone. */}
        <CalcadaMedallion size={64} className="-mb-2" />

        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {integrations.heading}
        </p>

        <ul className="flex flex-wrap items-center justify-center gap-3">
          {items.map((name) => (
            <li key={name}>
              <Badge
                variant="secondary"
                title={roles[name]}
                className="px-4 py-1.5 text-sm"
              >
                {name}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export default IntegrationStrip
