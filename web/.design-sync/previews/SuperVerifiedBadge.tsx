import { SuperVerifiedBadge } from '@access0x1/web'

// Real usage: components/CheckoutCard.tsx's buyer-tier gate renders exactly this,
// mapping the legacy {tier, score} API onto the shadcn Badge variants — standard
// (neutral outline), verified (green success), super-verified (the gold shimmer).
// The tier is the component's whole reason to exist, so it's the swept axis.
export const Tiers = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
    <SuperVerifiedBadge tier="standard" />
    <SuperVerifiedBadge tier="verified" score={50} />
    <SuperVerifiedBadge tier="super-verified" score={100} />
  </div>
)

// Ported from the real composition in CheckoutCard.tsx's buyer-tier precondition
// row: the badge sits inline with the merchant's requirement copy, inside the
// bordered gate card (green when met, neutral otherwise).
export const InCheckoutGate = () => (
  <div
    className="flex flex-col gap-2 rounded-xl border border-border bg-secondary p-4"
    style={{ maxWidth: 420 }}
  >
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-600">
        This merchant accepts Verified buyers.
      </span>
      <SuperVerifiedBadge tier="standard" score={10} />
    </div>
  </div>
)
