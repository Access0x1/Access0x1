import { WorldIdGate } from '@access0x1/web'

// The World ID buyer/operator gate. `NEXT_PUBLIC_WORLD_APP_ID` is unset in
// this design-sync build (see learnings/batch-D.md), so every cell below
// renders the component's own honest fail-soft branch — "Verification is not
// switched on for this checkout yet." That IS the real, correct behavior for
// an unconfigured deployment (lib/worldid/config.ts's documented degrade
// path), not a broken preview. The props still mirror the two real call
// sites so the composition is faithful even though today's render is
// necessarily identical across both.

// CheckoutCard.tsx: the buyer gate in front of pay.
export const BuyerGate = () => (
  <WorldIdGate
    signal="0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"
    onVerified={() => {}}
  />
)

// CheckoutModeForm.tsx: the merchant-operator "verified human" onboarding gate
// — a distinct action + verify route so its nullifier space never collides
// with the buyer gate above.
export const OperatorGate = () => (
  <WorldIdGate
    signal="tenant_nightwater-coffee"
    action="verified-operator"
    verifyUrl="/api/branding/operator-verify"
    extraBody={{ tenantId: 'tenant_nightwater-coffee' }}
    onVerified={() => {}}
  />
)
