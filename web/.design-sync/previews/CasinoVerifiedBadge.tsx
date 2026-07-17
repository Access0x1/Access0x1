import { CasinoVerifiedBadge } from '@access0x1/web'

// components/pages/SlugCheckoutView.tsx's real gate: a casino operator who
// completed World ID, on a 'verified-human' checkout, with World ID switched
// on — the green "Verified Humans Only · World ID" chip.
export const VerifiedHumansOnly = () => (
  <CasinoVerifiedBadge
    verifiedOperator
    checkoutMode="verified-human"
    vertical="casino"
    worldConfigured
  />
)

// components/branding/CheckoutModeForm.tsx's fail-soft branch: a casino wants
// the badge but World ID isn't configured yet — the honest amber notice
// instead of faking the green check (law #4).
export const WorldIdUnconfigured = () => (
  <CasinoVerifiedBadge
    verifiedOperator={false}
    checkoutMode="verified-human"
    vertical="casino"
    worldConfigured={false}
  />
)
