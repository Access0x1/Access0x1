import { VerificationLevels } from '@access0x1/web'

// Real usage: components/verification/VerificationLevelsPanel.tsx renders this
// with `profile?.methods ?? []` / `profile?.score ?? 0` before a profile has
// loaded — the L0 Guest starting state every verifying user begins from.
export const Guest = () => (
  <div style={{ maxWidth: 420 }}>
    <VerificationLevels methods={[]} score={0} />
  </div>
)

// Real profile shape from components/verification/VerificationStack.tsx: ENS +
// signed-in + a real wallet, World ID still missing. World ID is the FINAL
// capstone (lib/verification/tiers.ts), so this is the L2 Verified ceiling
// without it — the CTA switches to "Finish with World" once every other
// category is already done.
export const AlmostThere = () => (
  <div style={{ maxWidth: 420 }}>
    <VerificationLevels methods={['ens', 'dynamic', 'onchain']} score={50} />
  </div>
)

// The max rung: World ID scanned last, after ENS + sign-in + on-chain are all
// already complete — the celebratory L4 Super Verified state, no CTA.
export const SuperVerified = () => (
  <div style={{ maxWidth: 420 }}>
    <VerificationLevels methods={['world-id', 'ens', 'dynamic', 'onchain']} score={100} />
  </div>
)
