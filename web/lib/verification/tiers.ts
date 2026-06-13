/**
 * tiers.ts — the Super Verification trust-tier model (pure logic, unit-tested).
 *
 * The owner's ask: "if people verify they get a super verification; there are so
 * many ways to verify." This composes the verification methods Access0x1 ALREADY
 * has — each one a real check — into a single trust profile, score, and tier.
 *
 * METHODS (each adds to the profile; weights reflect how strong a personhood /
 * realness signal each is):
 *   - World ID   (proof-of-personhood, the existing /api/world/verify nullifier
 *                 gate) — the STRONGEST signal. Highest weight.
 *   - ENS        (the connected wallet forward-resolves to an ENS name via
 *                 lib/ens.resolveENS) — a medium signal of a real, named identity.
 *   - Dynamic    (the user is signed in via Dynamic — email/social/wallet) — a
 *                 low-medium signal that there is an account behind the session.
 *   - On-chain   (a funded wallet / a prior payment / an active SessionGrant =
 *                 "a real wallet, not a throwaway") — a low signal.
 *   - OIDC       (the user signed in with an OIDC provider — "Sign in with
 *                 Google" by default, any OIDC issuer or the operator's own
 *                 backend by env — and we verified the issuer-signed ID token) —
 *                 a low-medium signal of a real, provider-backed account.
 *
 * TIERS (the rungs the UI shows and the merchant gate enforces):
 *   - Standard       (0 methods)        — anyone.
 *   - Verified       (>=1 method)       — at least one real check passed; World
 *                                         ID counts as the strongest single rung.
 *   - Super Verified  (World ID + >=2 others, OR >=3 methods total) — the badge.
 *
 * This module is PURE: it never calls the network, reads env, or touches money.
 * The API route (app/api/verify) and the UI compose it; each method is verified
 * for real where possible and marked booth-gated where a testnet/dev-portal
 * limit applies (World ID Developer Portal, ENS mainnet resolver).
 */

/** The ways to verify, composed into one trust profile. */
export type VerificationMethod = 'world-id' | 'ens' | 'dynamic' | 'oidc' | 'onchain'

/** Every method, in display/priority order (World ID first — strongest). */
export const VERIFICATION_METHODS: readonly VerificationMethod[] = [
  'world-id',
  'ens',
  'dynamic',
  'oidc',
  'onchain',
] as const

/**
 * Per-method trust weight (points toward the score). World ID dominates because
 * it is the only true proof-of-personhood; the others are realness signals. OIDC
 * (a provider-signed "Sign in with Google" account) sits alongside Dynamic.
 */
export const METHOD_WEIGHTS: Readonly<Record<VerificationMethod, number>> = {
  'world-id': 50,
  ens: 25,
  dynamic: 15,
  oidc: 15,
  onchain: 10,
}

/** Human-facing label + "what it adds" copy for each method (UI source of truth). */
export const METHOD_INFO: Readonly<
  Record<VerificationMethod, { label: string; adds: string }>
> = {
  'world-id': {
    label: 'World ID',
    adds: 'Proves you are a real, unique person — the strongest check. We never see your name or face, only a yes.',
  },
  ens: {
    label: 'ENS name',
    adds: 'Your wallet resolves to a human-readable ENS name — a real, named identity.',
  },
  dynamic: {
    label: 'Signed in',
    adds: 'You are signed in with an email, social, or wallet account.',
  },
  oidc: {
    label: 'Sign in with Google',
    adds: 'You signed in with Google (or your configured OIDC provider) — a real, provider-backed account, verified from the signed ID token.',
  },
  onchain: {
    label: 'Real wallet',
    adds: 'Your wallet is funded or has paid before — not a brand-new throwaway.',
  },
}

/** The trust tiers, lowest to highest. */
export type TrustTier = 'standard' | 'verified' | 'super-verified'

/** Tier display metadata (UI source of truth). */
export const TIER_INFO: Readonly<Record<TrustTier, { label: string; rank: number }>> = {
  standard: { label: 'Standard', rank: 0 },
  verified: { label: 'Verified', rank: 1 },
  'super-verified': { label: 'Super Verified', rank: 2 },
}

/**
 * A user's verification profile: which methods they have completed. The store
 * persists exactly this (plus the user key); everything else is derived.
 */
export interface VerificationProfile {
  /** The methods this user has genuinely passed. */
  methods: VerificationMethod[]
}

/** An empty profile (no methods) — the Standard tier. */
export function emptyProfile(): VerificationProfile {
  return { methods: [] }
}

/** Normalize a profile's methods: dedupe + keep only known methods. */
export function normalizeMethods(methods: readonly VerificationMethod[]): VerificationMethod[] {
  const seen = new Set<VerificationMethod>()
  const out: VerificationMethod[] = []
  for (const m of VERIFICATION_METHODS) {
    if (methods.includes(m) && !seen.has(m)) {
      seen.add(m)
      out.push(m)
    }
  }
  return out
}

/** True when the profile includes World ID (the proof-of-personhood anchor). */
export function hasWorldId(profile: VerificationProfile): boolean {
  return profile.methods.includes('world-id')
}

/**
 * The trust SCORE: the summed weight of the completed methods, clamped to 100.
 * A pure number the UI renders as a meter and the merchant gate can threshold.
 */
export function computeTrustScore(profile: VerificationProfile): number {
  const methods = normalizeMethods(profile.methods)
  const raw = methods.reduce((sum, m) => sum + METHOD_WEIGHTS[m], 0)
  return Math.min(100, raw)
}

/**
 * The TIER, per the spec rules:
 *   - super-verified: World ID + >=2 others, OR >=3 methods total.
 *   - verified:       >=1 method (World ID counts as the strongest single rung).
 *   - standard:       0 methods.
 *
 * @param profile The user's verification profile.
 * @returns the earned tier.
 */
export function computeTier(profile: VerificationProfile): TrustTier {
  const methods = normalizeMethods(profile.methods)
  const count = methods.length
  if (count === 0) return 'standard'

  const worldId = methods.includes('world-id')
  const others = count - (worldId ? 1 : 0)

  // Super Verified: World ID anchored + at least two OTHER methods, OR three+
  // methods in total (a strong composite even without World ID).
  if ((worldId && others >= 2) || count >= 3) return 'super-verified'

  return 'verified'
}

/** True when `have` meets or exceeds `required` (the merchant gate predicate). */
export function tierMeets(have: TrustTier, required: TrustTier): boolean {
  return TIER_INFO[have].rank >= TIER_INFO[required].rank
}

/** Narrow an untrusted value into a {@link TrustTier}, defaulting to standard. */
export function asTrustTier(v: unknown): TrustTier {
  return v === 'verified' || v === 'super-verified' || v === 'standard' ? v : 'standard'
}

/** Narrow an untrusted value into a {@link VerificationMethod}, or null. */
export function asVerificationMethod(v: unknown): VerificationMethod | null {
  return v === 'world-id' || v === 'ens' || v === 'dynamic' || v === 'oidc' || v === 'onchain'
    ? v
    : null
}

/**
 * What the user still needs to reach Super Verified — the "verify more" hint the
 * UI shows. Returns a short, plain-English next step, or null when already there.
 */
export function nextStepToSuper(profile: VerificationProfile): string | null {
  if (computeTier(profile) === 'super-verified') return null
  const methods = normalizeMethods(profile.methods)
  if (!methods.includes('world-id')) {
    return 'Add World ID — the strongest check — to fast-track Super Verified.'
  }
  // Has World ID; needs two others.
  const remaining = VERIFICATION_METHODS.filter(
    (m) => m !== 'world-id' && !methods.includes(m),
  ).map((m) => METHOD_INFO[m].label)
  return `Add ${Math.max(0, 2 - (methods.length - 1))} more (${remaining.join(' or ')}) to become Super Verified.`
}
