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
  {
    key: 'ownName',
    contract: 'lib/ens/registrar.ts + ownName.ts',
    glyph: '🏷️',
    dev: 'The full ENS commit → 60s → register flow runs in-app, both transactions signed by the CONNECTED wallet — no server key, zero custody. The commitment secret survives a page refresh, and a doomed transaction (early register, expired commitment, switched wallet) is refused before it costs gas.',
    caveat: 'Registration runs on the testnet registrar the app is configured for; the step is hidden entirely until the controller address is configured.',
  },
  {
    key: 'verification',
    contract: 'World ID + Dynamic + ENS (the ladder)',
    glyph: '✅',
    dev: 'One trust ladder — signed-in, verified human (World ID), verified name — surfaced as a single chip with one next-rung button. Merchants gate writes on it; buyers see it on the checkout.',
    caveat: 'Each rung is off the money path: an unverified buyer can still pay; verification gates identity claims and merchant writes, never settlement.',
  },
  {
    key: 'aiInference',
    contract: 'lib/ai/inference.ts (Anthropic | 0G Compute)',
    glyph: '🧠',
    dev: 'One env var flips every AI feature between Anthropic and 0G Compute decentralized inference — key mode or a funded broker wallet minting signed per-request billing headers. Answers carry a visible "Computed on 0G Compute" badge when 0G served them.',
    caveat: 'The badge is claimed only when 0G actually served the request — a fallback answer never wears it.',
  },
  {
    key: 'payoutSwap',
    contract: 'lib/payout-swap (Uniswap · 1inch rails)',
    glyph: '🔄',
    dev: 'Merchants receive in any coin: settled USDC swaps through Uniswap (Trading API / classic / v4 hook) or 1inch, zero added fee, entirely AFTER settlement. The v4 SwapReceiptHook writes an on-chain receipt per swap.',
    caveat: 'Strictly off the money path — a rail failure degrades to "you keep USDC", it can never block or alter the payment itself.',
  },
  {
    key: 'proofOfPayment',
    contract: 'lib/proof/lastPayment.ts',
    glyph: '🧾',
    dev: 'One call answers "did it land?": the last settlement read straight from PaymentReceived logs — amount, buyer, order id, and the tx hash anyone can verify independently. No indexer, no extra gas stored on-chain.',
    caveat: 'It never reports a payment it cannot back with a real transaction hash — an unprovable log is refused, not rendered as paid.',
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
              {/* Hover does three small things at once instead of one: the border
                  warms, the card lifts half a step off the page, and the surface
                  brightens — so a pointer reads the card as a physical object it
                  can pick up rather than an outline that changed colour. The lift
                  is suppressed under prefers-reduced-motion; the colour is not,
                  because colour is the part carrying the affordance. */}
              <Card className="h-full transition-[transform,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card/80 motion-reduce:hover:translate-y-0">
                <CardHeader>
                  <div className="mb-2 flex items-center gap-2">
                    {/* The glyph sits in a calçada stone: a set roundel of the
                        secondary surface, sized to the row. A bare emoji floating
                        against the card had no shared silhouette card-to-card, so
                        seven different vendor drawings at seven different optical
                        weights read as clip art. The roundel is the constant, and
                        the emoji becomes its inlay. */}
                    <span
                      aria-hidden="true"
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-base leading-none"
                    >
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
