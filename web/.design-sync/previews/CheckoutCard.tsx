import { CheckoutCard } from '@access0x1/web'

// components/pages/CheckoutView.tsx's real wrapper (the "/m/[merchantId]"
// hosted checkout): a deliberate bright `.light` island on the dark chassis —
// `className="light rounded-2xl border border-border bg-card p-6 text-foreground"`.
// CheckoutCard's own `text-ink` / `bg-rail` / `bg-secondary` utilities are
// chassis-token-driven, so this wrapper is load-bearing, not decoration —
// dropping it would render the card against the wrong (dark) token set.
const LightIsland = ({ children }: { children: React.ReactNode }) => (
  <section className="light rounded-2xl border border-border bg-card p-6 text-foreground" style={{ maxWidth: 420 }}>
    {children}
  </section>
)

// The registered merchant record CheckoutCard reads (lib/contracts.ts#Merchant).
// feeBps: 0 mirrors RegisterForm.tsx's real self-registration default; payout
// doubles as owner/feeRecipient, matching the form's "defaults to your
// payout" placeholder when no separate fee recipient is set.
const MERCHANT_ACTIVE = {
  payout: '0x5d750aa6db3a6592dbab9e50b1661b49b4dd2312',
  owner: '0x5d750aa6db3a6592dbab9e50b1661b49b4dd2312',
  feeRecipient: '0x5d750aa6db3a6592dbab9e50b1661b49b4dd2312',
  feeBps: 0,
  active: true,
  nameHash: '0xd7640676ce161593536fe76174ae91d3cef5236b16a76068c260ef862bb8e5cd',
} as const

// BUYER = plain wagmi, no wallet extension in this static preview → every
// story lands on the real "not connected yet" branch (BuyerConnectButton),
// never a fabricated connected/paid look. Arc (5042002) is the canonical
// chain: it's the one chain whose USDC address resolves with NO env config
// (lib/chains.ts's Arc carve-out — see NOTES.md's "process is not defined"
// section for why every OTHER NEXT_PUBLIC_* var reads empty in this bundle),
// so the live-quote fetch actually fires instead of failing on an
// unconfigured-token error, and isGasFree(5042002) surfaces the real
// "no separate gas token" badge.
export const Default = () => (
  <LightIsland>
    <CheckoutCard
      chainId={5042002}
      merchantId={3n}
      merchant={MERCHANT_ACTIVE}
      merchantName="Acme Coffee"
      usdAmount="29.00"
      returnUrl="https://acmecoffee.example/thanks"
    />
  </LightIsland>
)

// A malformed `?amount=` (the exact case app/[m]/[merchantId] guards against:
// non-numeric, empty, or an overflowing price) — parseUsdAmount8 returns
// null and the card renders the honest inline error instead of crashing or
// quoting a junk amount (lib/quote.ts#parseUsdAmount8, CheckoutCard.tsx
// lines 373-389).
export const InvalidAmount = () => (
  <LightIsland>
    <CheckoutCard
      chainId={5042002}
      merchantId={3n}
      merchant={MERCHANT_ACTIVE}
      merchantName="Acme Coffee"
      usdAmount="abc"
    />
  </LightIsland>
)

// merchant.active === false (a merchant who paused payments, or whose seat
// hasn't been activated) — the real "not currently accepting payments"
// banner, still alongside the rest of the card (CheckoutCard.tsx line 459).
export const MerchantInactive = () => (
  <LightIsland>
    <CheckoutCard
      chainId={5042002}
      merchantId={3n}
      merchant={{ ...MERCHANT_ACTIVE, active: false }}
      merchantName="Acme Coffee"
      usdAmount="29.00"
    />
  </LightIsland>
)
