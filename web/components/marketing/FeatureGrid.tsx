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
import { DevNote, DevModeToggle } from '@/components/marketing/DevMode'
import type { Dictionary } from '@/lib/i18n/get-dictionary'

/**
 * Order + non-localized data for each capability. `key` indexes the localized
 * copy in dict.features.items; `contract` names the file in `src/` so the claim
 * stays verifiable; `glyph` is decorative.
 */
const FEATURE_ORDER = [
  {
    key: 'payments',
    contract: 'Access0x1Router.sol',
    glyph: '💸',
    dev: 'One `payToken` call prices USD→token through a Chainlink feed INSIDE the settlement transaction, then pulls, splits and pushes in the same tx. The router holds nothing between them — a fuzz invariant enforces a zero residual balance.',
    caveat: 'A stale or negative feed reverts the payment closed rather than settling on a bad price. Refunds carry no oracle dependency at all, so a dead feed can never block one.',
  },
  {
    key: 'subscriptions',
    contract: 'Access0x1Subscriptions.sol + AutomationGateway.sol',
    glyph: '🔁',
    dev: 'Renewal spends against an on-chain SessionGrant budget before it charges: `sessionGrant.spend()` → `router.quote()` → `router.payToken()`. A permissionless keeper drives it, so nobody has to be online.',
    caveat: 'The plan price is read LIVE at charge time, so the SessionGrant cap — not the plan — is the real ceiling on what can be pulled.',
  },
  {
    key: 'bookings',
    contract: 'Access0x1Bookings.sol',
    glyph: '📅',
    dev: 'A USD-priced deposit escrowed with the cancellation policy SNAPSHOTTED at reserve time, so a merchant cannot change the terms after you have booked.',
    caveat: 'The resolution-fee leg tolerates an oracle fault on purpose: if the feed is dead the fee is zero and the full escrow refunds, rather than the booking bricking.',
  },
  {
    key: 'invoices',
    contract: 'Access0x1Invoices.sol + Receivables.sol',
    glyph: '🧾',
    dev: 'An open invoice can mint a transferable ERC-721 — whoever HOLDS it is the on-chain creditor and receives the settled net. That is factoring, without a factor.',
    caveat: 'The fee is snapshotted at mint, so a merchant cannot raise it after the receivable has changed hands.',
  },
  {
    key: 'giftCards',
    contract: 'Access0x1GiftCards.sol',
    glyph: '🎁',
    dev: 'Stored value as an on-chain balance, redeemed against a one-shot redemption id so a replay cannot double-spend a card.',
    caveat: 'The redemption ledger is global rather than per-card — a known gap, written up in the commit history, not yet closed.',
  },
  {
    key: 'agents',
    contract: 'SessionGrant.sol',
    glyph: '🤖',
    dev: 'A signed, time-boxed, budget-capped mandate. The delegate spends against it; the owner can revoke at any moment, permanently. A symbolic proof covers spend-never-exceeds-budget.',
    caveat: 'Exactly one contract can spend a grant today — Access0x1Subscriptions. An agent cannot yet buy an asset under a mandate; that needs one more function.',
  },
  {
    key: 'ens',
    contract: 'ENS resolution (ENSIP-19)',
    glyph: '🪪',
    dev: 'A name is shown only when ENS proves it resolves BACK to the exact payout address — forward and reverse must agree. Registration resolves on-chain and throws rather than storing a wrong payout.',
    caveat: 'The checkout badge is off the money path by design: if the lookup fails you see the raw address, and the payment is unaffected.',
  },
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
        {/* The two audiences on this page want opposite things. Rather than pick one,
            let the reader say which they are — and answer in place. */}
        <DevModeToggle className="mt-5" />
      </div>

      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURE_ORDER.map(({ key, contract, glyph, dev, caveat }) => {
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
                  <DevNote contract={contract} caveat={caveat}>
                    {dev}
                  </DevNote>
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
