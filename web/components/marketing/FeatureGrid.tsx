/**
 * FeatureGrid.tsx — the capability grid on the marketing landing page.
 *
 * A static, server-renderable grid that maps the Access0x1 on-chain surface to
 * plain-English (now localized) capabilities. Each card names one product area
 * and the contract(s) that power it, so a developer reading the page can connect
 * the pitch to the actual lineup in `src/`.
 *
 * Split of concerns: the per-feature GLYPH (decorative) and the BACKING CONTRACT
 * (a code identifier — the receipt behind the claim) stay LITERAL; the title +
 * description are localized (dict.features.items[key]).
 */
import type { ReactNode } from 'react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { Dictionary } from '@/lib/i18n/get-dictionary'

/**
 * Order + non-localized data for each capability. `key` indexes the localized
 * copy in dict.features.items; `contract` names the file in `src/` so the claim
 * stays verifiable; `glyph` is decorative.
 */
const FEATURE_ORDER = [
  { key: 'payments', contract: 'Access0x1Router.sol', glyph: '💸' },
  {
    key: 'subscriptions',
    contract: 'Access0x1Subscriptions.sol + AutomationGateway.sol',
    glyph: '🔁',
  },
  { key: 'bookings', contract: 'Access0x1Bookings.sol', glyph: '📅' },
  { key: 'invoices', contract: 'Access0x1Invoices.sol + Receivables.sol', glyph: '🧾' },
  { key: 'giftCards', contract: 'Access0x1GiftCards.sol', glyph: '🎁' },
  { key: 'agents', contract: 'SessionGrant.sol', glyph: '🤖' },
  { key: 'ens', contract: 'ENS resolution (ENSIP-19)', glyph: '🪪' },
] as const

export interface FeatureGridProps {
  features: Dictionary['features']
}

export function FeatureGrid({ features }: FeatureGridProps): ReactNode {
  return (
    <section className="mx-auto max-w-5xl px-6 py-20">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {features.heading}
        </h2>
        <p className="mt-3 text-balance text-muted-foreground">{features.sub}</p>
      </div>

      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURE_ORDER.map(({ key, contract, glyph }) => {
          const item = features.items[key]
          return (
            <li key={key} className="contents">
              <Card className="h-full transition-colors hover:border-primary/50">
                <CardHeader>
                  <div className="mb-2 flex items-center gap-2">
                    <span aria-hidden="true" className="text-xl leading-none">
                      {glyph}
                    </span>
                    <CardTitle className="text-base">{item.title}</CardTitle>
                  </div>
                  <CardDescription className="leading-relaxed">
                    {item.description}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {/* The backing contract — the receipt for each claim. Literal. */}
                  <Badge variant="outline" className="font-mono text-[0.7rem]">
                    {contract}
                  </Badge>
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default FeatureGrid
