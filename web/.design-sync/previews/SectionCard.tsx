import { SectionCard } from '@access0x1/web'

// The shared rounded-2xl bordered card on the merchant surfaces. Real usage
// sweeps the surface via `className` — the default border/bg-card shape, a
// rail-tinted "action needed" card, and a neutral error card. Content is the
// real copy from those call sites (DashboardView.tsx), not invented text.

export const Default = () => (
  <SectionCard className="flex flex-col gap-4 border-rail/30 bg-rail/5">
    <div>
      <h2 className="text-lg font-semibold text-ink">Switch on payments</h2>
      <p className="text-sm text-muted-foreground">
        Your branded checkout is ready. Finish the quick one-time on-chain setup to start accepting
        USDC — no further steps after this.
      </p>
    </div>
  </SectionCard>
)

export const LoadError = () => (
  <SectionCard className="flex flex-col gap-3 bg-secondary">
    <p className="text-sm text-muted-foreground">Couldn&apos;t load your account — refresh to try again.</p>
    <button
      type="button"
      className="self-start rounded-lg border border-input px-3 py-1.5 text-sm hover:bg-secondary"
    >
      Refresh
    </button>
  </SectionCard>
)

export const ConnectGate = () => (
  <SectionCard className="flex flex-col items-center gap-5 px-6 py-12 text-center">
    <h2 className="font-display text-xl font-semibold text-foreground">
      Sign in to build your checkout
    </h2>
    <p className="max-w-sm text-sm text-muted-foreground">
      Connect your wallet and you&rsquo;ll set your business name, a one-line description, and a logo
      — then get a branded checkout link that accepts USDC. It takes under two minutes.
    </p>
  </SectionCard>
)
