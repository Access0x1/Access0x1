/**
 * FeatureGrid.tsx — the capability grid on the marketing landing page.
 *
 * A static, server-renderable grid that maps the Access0x1 on-chain surface to
 * plain-English capabilities. Each card names one product area and the contract
 * (or contracts) that powers it, so a developer reading the page can connect the
 * pitch to the actual lineup in `src/`. No client JS — the data is a const array
 * rendered through the shadcn `Card` family and brand tokens.
 *
 * The set deliberately covers the seven headline areas the landing page leads
 * with — payments, subscriptions, bookings, invoices, gift cards,
 * agents/SessionGrant, and ENS identity — each backed by a real shipped
 * contract so nothing here is aspirational.
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

/** One capability card: a product area, its blurb, and the backing contract. */
interface Feature {
  /** Short, human title for the capability. */
  title: string
  /** One-line, plain-English description of what it does for a business. */
  description: string
  /** The on-chain contract(s) that power it — the proof behind the pitch. */
  contract: string
  /** A small decorative glyph (inline emoji) — purely visual, aria-hidden. */
  glyph: string
}

/**
 * The capability set. Ordered to lead with the money spine (payments) and walk
 * outward through commerce, then identity + agents. Each `contract` string
 * names the file in `src/` so the claim is verifiable.
 */
const FEATURES: readonly Feature[] = [
  {
    title: 'Payments',
    description:
      'Accept USD-priced crypto with one link. A Chainlink feed quotes the price inside the pay transaction; funds settle merchant-to-payout with zero custody.',
    contract: 'Access0x1Router.sol',
    glyph: '💸',
  },
  {
    title: 'Subscriptions',
    description:
      'Recurring on-chain billing that renews itself — a permissionless Chainlink Automation keeper charges due plans, never holding a balance.',
    contract: 'Access0x1Subscriptions.sol + AutomationGateway.sol',
    glyph: '🔁',
  },
  {
    title: 'Bookings',
    description:
      'Take reservations and paid appointments on-chain, with the deposit collected through the same no-custody settlement path.',
    contract: 'Access0x1Bookings.sol',
    glyph: '📅',
  },
  {
    title: 'Invoices',
    description:
      'Issue and settle invoices in USDC — track receivables on-chain and let a customer pay a request with a single link.',
    contract: 'Access0x1Invoices.sol + Receivables.sol',
    glyph: '🧾',
  },
  {
    title: 'Gift cards',
    description:
      'Mint, redeem, and reload stored-value gift cards as on-chain balances your customers can spend across your storefront.',
    contract: 'Access0x1GiftCards.sol',
    glyph: '🎁',
  },
  {
    title: 'Agents · SessionGrant',
    description:
      'Delegate scoped, time-boxed spending to an agent or session key — a signed grant lets software pay on your behalf within limits you set.',
    contract: 'SessionGrant.sol',
    glyph: '🤖',
  },
  {
    title: 'ENS identity',
    description:
      'Pay a verified human-readable name instead of a hex address. Checkout resolves and proves the merchant’s ENS name before a cent moves.',
    contract: 'ENS resolution (ENSIP-19)',
    glyph: '🪪',
  },
]

export function FeatureGrid(): ReactNode {
  return (
    <section className="mx-auto max-w-5xl px-6 py-20">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          One center, the whole commerce stack
        </h2>
        <p className="mt-3 text-balance text-muted-foreground">
          Twelve open-source contracts behind a single link. Turn on only what
          you need — every piece shares the same no-custody settlement spine.
        </p>
      </div>

      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <li key={feature.title} className="contents">
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardHeader>
                <div className="mb-2 flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="text-xl leading-none"
                  >
                    {feature.glyph}
                  </span>
                  <CardTitle className="text-base">{feature.title}</CardTitle>
                </div>
                <CardDescription className="leading-relaxed">
                  {feature.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {/* The backing contract — the receipt for each claim. */}
                <Badge variant="outline" className="font-mono text-[0.7rem]">
                  {feature.contract}
                </Badge>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default FeatureGrid
