import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { BrandMark } from '@/components/BrandMark'
import { LandingCTA } from '@/components/marketing/LandingCTA'

/**
 * /vision — what gets built on the rail.
 *
 * The six product concepts the rail exists to make possible, plus the
 * deployment recipe that makes them credible. Every entry passes one bar: it
 * must be impossible on rails that can freeze, censor, or quietly change the
 * deal. Written in primitives (escrow, proof of personhood, state channels) —
 * no vendor names, no partnership claims. VISION, not shipped features: the
 * rail itself runs on test networks today.
 *
 * Pure presentational, server-renderable: no hooks, no client JS. Styling
 * rides the existing brand chassis (background / foreground / primary /
 * border / card / font-display) — no new tokens introduced.
 */

export const metadata: Metadata = {
  title: 'Vision — what gets built on the rail | Access0x1',
  description:
    'Six products, one bar: each must be impossible on rails that can freeze, ' +
    'censor, or quietly change the deal. Refunds that cannot be blocked, tickets ' +
    'that cannot be rugged, businesses that cannot be turned off — built on the ' +
    'open-source rail for onchain identity and USD-priced payments in USDC.',
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
    title: 'The Unblockable Refund',
    thesis: 'Commerce where the refund is physics, not policy.',
    body:
      'Every checkout escrows into a contract with a refund window that nobody — ' +
      'not the merchant, not us, not a court order to a server — can block, ' +
      'because there is no server. A processor can freeze a payout; a contract ' +
      'with no pause on the exit path cannot.',
  },
  {
    id: 'one-human-one-x',
    n: 2,
    title: 'One human, one X',
    thesis: 'Commerce that can prove a person, not a bot.',
    body:
      'A discount each human can claim exactly once across every merchant on the ' +
      'rail. Reviews provably written by a unique human who provably paid — the ' +
      'receipt is on-chain. Fair-queue ticket drops where bots are ' +
      'cryptographically impossible. It takes zero-knowledge proof of personhood ' +
      'joined to an unforgeable payment record, and that join only exists here.',
  },
  {
    id: 'unruggable-ticket',
    n: 3,
    title: 'The Unruggable Ticket',
    thesis: 'The rules live inside the ticket, not in a terms-of-service page.',
    body:
      'A ticket whose resale price cap, organizer royalty, and automatic ' +
      'refund-if-cancelled live inside the asset itself — and the only market it ' +
      'trades on enforces those rules at swap time. Scalpers cannot scalp, venues ' +
      'cannot rug, and nobody can quietly change the deal, because the contract ' +
      'is immutable.',
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
      'probate, no custodian, no off switch.',
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
      'automation. Nobody can fire it, defund it, or turn it off.',
  },
]

const RECIPE_ITEMS: readonly string[] = [
  'Immutable contracts — no proxy; roles renounced or burned to a timelock.',
  'Frontend on IPFS + ENS — no host to seize, no DNS to hijack.',
  'Permissionless indexing — anyone can rebuild the history from the chain.',
  'Receipts and documents anchored on public networks — provable forever.',
]

export default function VisionPage(): ReactNode {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 pb-24 pt-16">
      {/* Brand lockup + eyebrow, same chassis as the landing. */}
      <header className="flex flex-col items-start gap-5">
        <BrandMark size={20} />
        <span className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          The vision — what gets built on this rail
        </span>
        <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight text-foreground sm:text-5xl">
          Six products. One bar: impossible anywhere else.
        </h1>
        <p className="max-w-xl text-balance text-lg text-muted-foreground">
          Each of these must be impossible on rails that can freeze, censor, or
          quietly change the deal. That is the point of building on an open,
          immutable rail — the guarantee lives in the contract.
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
          Everything above ships on the same stack, so the guarantee is
          structural:
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
          &ldquo;We couldn&rsquo;t rug you if we wanted to.&rdquo;
        </p>
      </section>

      {/* Straight back into the funnel — same CTA as the landing. */}
      <section className="mt-14 text-center">
        <p className="mx-auto max-w-lg text-balance text-muted-foreground">
          The rail these are built on is open source and live on test networks
          today.
        </p>
        <LandingCTA className="mt-6" />
      </section>
    </main>
  )
}
