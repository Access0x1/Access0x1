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

/* ────────────────────────────────────────────────────────────────────────────
 * The 5-rung LEVEL ladder (verification-levels ADR). This sits ON TOP of the
 * existing tier model: the same method weights + score feed a finer-grained
 * 0..4 ladder the new shadcn UI renders. The legacy 3-tier model (Standard /
 * Verified / Super Verified) is preserved above and maps cleanly onto these
 * levels (see `tierToLevel` / `levelToTier`), so existing consumers keep working.
 *
 * Rungs (score 0..100; methods World ID 50 / ENS 25 / Sign-in 15 / On-chain 10):
 *   L0 Guest          — score 0, no verification.
 *   L1 Connected      — signed in OR a real wallet (score ~10–15). "Someone."
 *   L2 Verified       — one strong proof: World ID, OR (ENS + a sign-in)
 *                       (score ~25–50). A verified entity.
 *   L3 Trusted        — World ID + one more method (score ~50–75).
 *   L4 Super Verified — World ID + >=2 others, OR all four, OR score >= 75.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A numeric level on the ladder, 0 (Guest) through 4 (Super Verified). */
export type VerificationLevel = 0 | 1 | 2 | 3 | 4

/** The named labels for each level, indexed by the numeric level. */
export const LEVEL_LABELS: Readonly<Record<VerificationLevel, string>> = {
  0: 'Guest',
  1: 'Connected',
  2: 'Verified',
  3: 'Trusted',
  4: 'Super Verified',
}

/** Per-level display metadata (UI source of truth: label + one-line blurb). */
export const LEVEL_INFO: Readonly<
  Record<VerificationLevel, { label: string; blurb: string }>
> = {
  0: { label: 'Guest', blurb: 'No verification yet — you can browse, but trust-gated actions are locked.' },
  1: { label: 'Connected', blurb: 'Signed in or a real wallet — you’re someone, not yet proven.' },
  2: { label: 'Verified', blurb: 'One strong proof in hand — a verified entity.' },
  3: { label: 'Trusted', blurb: 'World ID plus another check — a trusted, real identity.' },
  4: { label: 'Super Verified', blurb: 'The pinnacle: World ID plus two or more other checks.' },
}

/** The "sign-in" methods (an authenticated account — Dynamic OR OIDC). */
const SIGN_IN_METHODS: readonly VerificationMethod[] = ['dynamic', 'oidc'] as const

/** The result of {@link levelFor}: the rung, its name, and the next-step hint. */
export interface LevelResult {
  /** The numeric level, 0..4. */
  level: VerificationLevel
  /** The named rung ("Guest" | "Connected" | "Verified" | "Trusted" | "Super Verified"). */
  name: string
  /**
   * Plain-English "what to add next" to climb a rung — or '' when already at L4
   * Super Verified. Points at the single highest-value method still missing.
   */
  nextNeed: string
}

/**
 * The level a (score, methods) pair earns — the finer 5-rung ladder.
 *
 * PURE: derives only from the methods (deduped) and the score. The `score`
 * argument lets a caller pass an already-computed score; when omitted it is
 * computed from the methods, so `levelFor(methods)` and
 * `levelFor(score, methods)` both work.
 *
 * Rules (in descending order):
 *   - L4 Super Verified: World ID + >=2 others, OR all four methods, OR score >= 75.
 *   - L3 Trusted:        World ID + exactly one other (score ~50–75).
 *   - L2 Verified:       one strong proof — World ID alone, OR ENS + a sign-in,
 *                        OR score >= 25 from any composite.
 *   - L1 Connected:      at least one method but below Verified (a lone sign-in /
 *                        ENS / on-chain signal — "someone").
 *   - L0 Guest:          no methods.
 *
 * @param a   Either the precomputed score, or the methods list.
 * @param b   The methods list (when `a` is the score).
 */
export function levelFor(
  a: number | readonly VerificationMethod[],
  b?: readonly VerificationMethod[],
): LevelResult {
  // Overload handling: (methods) or (score, methods).
  const rawMethods = typeof a === 'number' ? (b ?? []) : a
  const methods = normalizeMethods(rawMethods)
  const score =
    typeof a === 'number' ? a : computeTrustScore({ methods })

  const worldId = methods.includes('world-id')
  const hasEns = methods.includes('ens')
  const hasSignIn = methods.some((m) => SIGN_IN_METHODS.includes(m))
  const others = methods.filter((m) => m !== 'world-id').length

  let level: VerificationLevel
  if (methods.length === 0) {
    // L0 Guest — nothing proven.
    level = 0
  } else if (worldId) {
    // World-ID-anchored ladder (the structural rungs take precedence over a
    // bare score so World ID + exactly one other reads as Trusted, not Super):
    //   +2 others (or all four) -> L4 Super Verified
    //   +1 other                -> L3 Trusted
    //   alone                   -> L2 Verified
    level = others >= 2 ? 4 : others === 1 ? 3 : 2
  } else if (methods.length >= 4 || score >= 75) {
    // No World ID, but a strong composite (all four non-WID is impossible since
    // WID is one of five; >=4 here means a deep stack) or score >= 75 — L4.
    level = 4
  } else if ((hasEns && hasSignIn) || score >= 25) {
    // One strong proof without World ID: ENS + a sign-in, or any score >= 25.
    level = 2
  } else {
    // At least one method but below Verified — "someone," L1 Connected.
    level = 1
  }

  return { level, name: LEVEL_LABELS[level], nextNeed: nextNeedFor(level, methods) }
}

/**
 * The single highest-value next step to climb from `level` given `methods`.
 * Plain-English, non-coder copy (no jargon). Empty string at L4.
 */
function nextNeedFor(
  level: VerificationLevel,
  methods: readonly VerificationMethod[],
): string {
  if (level >= 4) return ''
  const has = (m: VerificationMethod): boolean => methods.includes(m)
  // World ID is the strongest single add — recommend it first whenever missing.
  if (!has('world-id')) {
    return `Add ${METHOD_INFO['world-id'].label} — the strongest check — to reach ${LEVEL_LABELS[nextLevel(level)]}.`
  }
  // Has World ID: recommend the next-highest-weight method still missing.
  const next = VERIFICATION_METHODS.filter(
    (m) => m !== 'world-id' && !has(m),
  ).sort((x, y) => METHOD_WEIGHTS[y] - METHOD_WEIGHTS[x])[0]
  if (next) {
    return `Add ${METHOD_INFO[next].label} to reach ${LEVEL_LABELS[nextLevel(level)]}.`
  }
  return `Add another check to reach ${LEVEL_LABELS[nextLevel(level)]}.`
}

/** The next rung up (clamped at 4). */
function nextLevel(level: VerificationLevel): VerificationLevel {
  return Math.min(4, level + 1) as VerificationLevel
}

/**
 * Map a legacy {@link TrustTier} onto the 5-rung ladder, so existing consumers
 * (the merchant gate, the badge) can render a level. standard→L1, verified→L2,
 * super-verified→L4 (the legacy model has no L0/L3 distinction).
 */
export function tierToLevel(tier: TrustTier): VerificationLevel {
  return tier === 'super-verified' ? 4 : tier === 'verified' ? 2 : 1
}

/**
 * Map a level back onto the legacy {@link TrustTier} for the merchant gate
 * (which still threshold-compares tiers). L0/L1→standard, L2/L3→verified,
 * L4→super-verified. The gate semantics are unchanged.
 */
export function levelToTier(level: VerificationLevel): TrustTier {
  if (level >= 4) return 'super-verified'
  if (level >= 2) return 'verified'
  return 'standard'
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
