/**
 * IntegrationStrip.tsx — the "works with" trust strip on the landing page.
 *
 * A static, server-renderable row of partner badges showing what Access0x1 is
 * built on: Chainlink (USD price feeds + Automation) and the settlement chains.
 * Each badge is a plain label (no external logo request).
 *
 * Split of concerns: the partner/chain NAMES are proper nouns and stay LITERAL;
 * the heading + each role tooltip are localized (dict.integrations).
 *
 * NOTE (HONESTY follow-up, tracked separately): this chain list is still a
 * hand-authored order. The honesty pass drives it from gen-deployments truth so
 * "live on" reflects only actually-deployed testnets — that PR replaces
 * CHAIN_ORDER + the role keys with the generated deploy table.
 */
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import type { Dictionary } from '@/lib/i18n/get-dictionary'

/** Chain/partner names (literal) in build-order priority; roles come from the dict. */
const CHAIN_ORDER = ['Chainlink', 'Arc', 'Base', 'zkSync'] as const

export interface IntegrationStripProps {
  integrations: Dictionary['integrations']
}

export function IntegrationStrip({ integrations }: IntegrationStripProps): ReactNode {
  return (
    <section className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex flex-col items-center gap-6 rounded-2xl border border-border bg-card/50 px-6 py-8">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {integrations.heading}
        </p>

        <ul className="flex flex-wrap items-center justify-center gap-3">
          {CHAIN_ORDER.map((name) => (
            <li key={name}>
              <Badge
                variant="secondary"
                title={integrations.roles[name]}
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
