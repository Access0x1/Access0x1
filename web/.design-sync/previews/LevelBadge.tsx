import { LevelBadge } from '@access0x1/web'

// The primary axis is `level` (0-4) — the full ladder from
// components/verification/VerificationLevels.tsx's real rung names
// (LEVEL_LABELS: Guest, Connected, Verified, Trusted, Super Verified).
export const Levels = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
    <LevelBadge level={0} name="Guest" />
    <LevelBadge level={1} name="Connected" />
    <LevelBadge level={2} name="Verified" />
    <LevelBadge level={3} name="Trusted" />
    <LevelBadge level={4} name="Super Verified" />
  </div>
)

// L4 is the distinct gold/gradient shimmer rung (the pinnacle) — spotlighted
// on its own, per the component's own JSDoc ("the distinct gold/gradient
// shimmer Badge").
export const SuperVerified = () => <LevelBadge level={4} name="Super Verified" />
