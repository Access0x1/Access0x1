import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { BrandMark } from '@/components/BrandMark'
import { LandingCTA } from '@/components/marketing/LandingCTA'
import { getLocale } from '@/lib/i18n/locale'
import { getDictionary } from '@/lib/i18n/get-dictionary'

/**
 * /vision — what gets built on the rail.
 *
 * The six product concepts the rail exists to make possible, plus the
 * deployment recipe that makes them credible. Every entry passes one bar: the
 * rule has to live in a published contract rather than in a policy page.
 * Written in primitives (escrow, proof of personhood, state channels) — no
 * vendor names, no partnership claims. VISION, not shipped features: the rail
 * itself runs on test networks today.
 *
 * CLAIM SCOPE (2026-07-30 review). This page may not assert that a refund is
 * unblockable, that contracts are immutable, or that no party can interfere.
 * Verified against source + chain: `Refunds` requires the MERCHANT to fund and
 * authorize before the buyer's `claim` is available; `Access0x1Escrow.cancel`
 * is SELLER-only (its permissionless `claimAfterTimeout` releases to the
 * SELLER); only `Access0x1Bookings.cancel` admits the PAYER as a caller, and
 * even there the outcome is set by the policy snapshot, which may define a
 * no-refund window. Every one of these is a UUPS proxy whose upgrade authority
 * is a live EOA (0xa121…8d73 on all eight mirror testnets), so no copy here may
 * promise the rules cannot change.
 *
 * Pure presentational, server-renderable: no hooks, no client JS. Styling
 * rides the existing brand chassis (background / foreground / primary /
 * border / card / font-display) — no new tokens introduced.
 */

export const metadata: Metadata = {
  title: 'Vision — what gets built on the rail | Access0x1',
  description:
    'Six products, one bar: the rule lives in a published contract you can ' +
    'inspect and call yourself, not in a policy page. Refunds whose payout the ' +
    'merchant cannot withhold, resale terms that travel with the ticket, and ' +
    'treasuries that keep paying — built on the open-source rail for onchain ' +
    'identity and USD-priced payments in USDC. Runs on test networks today.',
}

interface Concept {
  /** Stable anchor id. */
  id: string
  /** Display ordinal, 1-based. */
  n: number
  title: string
  /** One-line thesis — the hook under the title. */
  thesis: string
  /** Why this can only exist on the rail. */
  body: string
}

const CONCEPTS: readonly Concept[] = [
  {
    id: 'unblockable-refund',
    n: 1,
    title: 'The refund a merchant cannot withhold',
    thesis: 'The payout path has no approval step and no pause.',
    body:
      'A deposit booking can be cancelled by the payer, not only by the ' +
      'merchant, and what comes back is set by a cancellation policy snapshotted ' +
      'when the booking was made — an operator cannot raise the fee after the ' +
      'fact. Once a refund is owed, the payout cannot be withheld: there is no ' +
      'approval step and no pause on the exit path, and a transfer that fails ' +
      'lands in a pull-map the payer claims themselves. What it is not is ' +
      'unconditional — the policy can define a no-refund window, and the ' +
      'settlement asset and network still apply their own rules.',
  },
  {
    id: 'one-human-one-x',
    n: 2,
    title: 'One human, one X',
    thesis: 'Commerce that can prove a person, not a bot.',
    body:
      'A discount each human can claim exactly once across every merchant on the ' +
      'rail. Reviews provably written by a unique human who provably paid — the ' +
      'receipt is on-chain. Fair-queue ticket drops where a second entry costs a ' +
      'second proof of personhood, so scripting one wallet into a thousand stops ' +
      'paying. It takes zero-knowledge proof of personhood joined to a payment ' +
      'record, and that join only exists here.',
  },
  {
    id: 'unruggable-ticket',
    n: 3,
    title: 'The Unruggable Ticket',
    thesis: 'The rules live inside the ticket, not in a terms-of-service page.',
    body:
      'A ticket whose resale price cap, organizer royalty, and automatic ' +
      'refund-if-cancelled live inside the asset itself — and the only market it ' +
      'trades on enforces those rules at swap time. Scalpers cannot scalp and ' +
      'venues cannot rug, because those rules are fixed in the ticket contract at ' +
      'mint rather than in a policy page — and shipping it means freezing that ' +
      'contract’s upgrade path first.',
  },
  {
    id: 'immortal-business',
    n: 4,
    title: 'The Immortal Business',
    thesis: 'A treasury with succession built in.',
    body:
      'A merchant whose treasury streams payroll and pays suppliers on its own. ' +
      'If the owner’s heartbeat stops — no signed check-in — the contract ' +
      'executes succession: funds stream to heirs and staff on a schedule. No ' +
      'probate and no custodian in the loop — the schedule runs from the ' +
      'contract, not from an office that can close.',
  },
  {
    id: 'pay-per-second',
    n: 5,
    title: 'Pay-per-second work',
    thesis: 'Earnings that accrue by the second and settle once.',
    body:
      'Wages or usage metered off-chain per second with cryptographic finality, ' +
      'settled on-chain in a single transaction. Self-custody payroll with no ' +
      'processor in the loop — micro-granularity economics that card rails ' +
      'cannot express.',
  },
  {
    id: 'ai-that-owns-itself',
    n: 6,
    title: 'The AI that owns itself',
    thesis: 'An economic organism, not a SaaS.',
    body:
      'An agent with its own wallet: it earns fees on the rail, pays for its own ' +
      'inference and storage, and renews its own existence through decentralized ' +
      'automation. It is not an employee to fire or a subscription to cancel — ' +
      'it keeps running as long as it can pay its own bills.',
  },
]

const RECIPE_ITEMS: readonly string[] = [
  'Frozen contracts — no live upgrade path; ownership renounced or held by a timelock.',
  'Frontend on IPFS + ENS — no host to seize, no DNS to hijack.',
  'Permissionless indexing — anyone can rebuild the history from the chain.',
  'Receipts and documents anchored on public networks — provable forever.',
]

export default async function VisionPage(): Promise<ReactNode> {
  // Full /vision localization is the next PR; here we only feed the shared CTA
  // its localized copy so the button matches the rest of the site.
  const dict = getDictionary(await getLocale())
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 pb-24 pt-16">
      {/* Brand lockup + eyebrow, same chassis as the landing. */}
      <header className="flex flex-col items-start gap-5">
        <BrandMark size={20} />
        <span className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          The vision — what gets built on this rail
        </span>
        <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight text-foreground sm:text-5xl">
          Six products. One bar: the rule lives in the contract.
        </h1>
        <p className="max-w-xl text-balance text-lg text-muted-foreground">
          Each of these needs a rule you can inspect and call yourself, not a
          policy you have to take on trust. That is the point of building on an
          open rail — the terms are published where anyone can read them.
        </p>
      </header>

      {/* The six — simple stacked cards in the rail's chrome. */}
      <section className="mt-14 flex flex-col gap-4">
        {CONCEPTS.map((c) => (
          <article
            key={c.id}
            id={c.id}
            className="rounded-2xl border border-border bg-card p-6"
          >
            <div className="font-mono text-xs text-muted-foreground">
              {String(c.n).padStart(2, '0')}
            </div>
            <h2 className="mt-2 font-display text-xl font-semibold text-foreground">
              {c.title}
            </h2>
            <p className="mt-1 text-sm font-medium text-primary">{c.thesis}</p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {c.body}
            </p>
          </article>
        ))}
      </section>

      {/* The recipe — why "never taken down" is a property, not a promise. */}
      <section className="mt-14 rounded-2xl border border-border bg-card p-8">
        <h2 className="font-display text-sm font-semibold uppercase tracking-widest text-primary">
          The &ldquo;never taken down&rdquo; recipe
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Everything above has to clear the same bar before it ships. This is
          the requirement, not a description of today &mdash; the rail&rsquo;s
          contracts are still upgradeable by their deployer:
        </p>
        <ul className="mt-5 flex flex-col gap-3">
          {RECIPE_ITEMS.map((item) => (
            <li key={item} className="flex items-start gap-3 text-sm">
              <span
                aria-hidden="true"
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
              />
              <span className="leading-relaxed text-foreground">{item}</span>
            </li>
          ))}
        </ul>
        <p className="mt-7 font-display text-lg font-semibold text-primary">
          &ldquo;The bar: you shouldn&rsquo;t have to trust us.&rdquo;
        </p>
      </section>

      {/* Straight back into the funnel — same CTA as the landing. */}
      <section className="mt-14 text-center">
        <p className="mx-auto max-w-lg text-balance text-muted-foreground">
          The rail these are built on is open source and live on test networks
          today.
        </p>
        <LandingCTA cta={dict.cta} className="mt-6" />
      </section>
    </main>
  )
}
