/**
 * ladder.ts — the simple 3-rung verification ladder (pure logic, unit-tested).
 *
 * The owner's ask: "don't make it that difficult." The full trust model
 * (tiers.ts: five methods, weights, five levels) stays the source of truth for
 * the score and the merchant gate — this module maps a profile onto the THREE
 * rungs a human actually sees, and picks EXACTLY ONE next action:
 *
 *   ○  Connected       — wallet connected, nothing proven yet.
 *   ✓  Verified        — ONE strong proof: an ENS name that forward-resolves to
 *                        the connected wallet, OR a World ID real-person check.
 *   ✓✓ Super Verified  — BOTH strong proofs plus a verified sign-in.
 *
 * The UI never shows a panel of providers. It shows the chip (○ → ✓ → ✓✓) and
 * one button for the single next step, chosen here — never a menu.
 *
 * PURE: no network, no env, no money. The VerificationLadder component owns the
 * data (the /api/verify profile) and the actions; this module only decides.
 */

import type { VerificationMethod } from './tiers'

/** The rung on the simple ladder: 0 = ○ Connected, 1 = ✓ Verified, 2 = ✓✓ Super. */
export type LadderRung = 0 | 1 | 2

/** Display metadata per rung (UI source of truth for the chip row). */
export const RUNG_INFO: Readonly<
  Record<LadderRung, { symbol: string; label: string; blurb: string }>
> = {
  0: {
    symbol: '○',
    label: 'Connected',
    blurb: 'Your wallet is connected — nothing proven yet.',
  },
  1: {
    symbol: '✓',
    label: 'Verified',
    blurb: 'One strong proof — a named ENS identity or a real-person check.',
  },
  2: {
    symbol: '✓✓',
    label: 'Super Verified',
    blurb: 'Both strong proofs plus a verified sign-in — the top rung.',
  },
}

/** Every rung, in climb order — the chip row renders exactly these. */
export const LADDER_RUNGS: readonly LadderRung[] = [0, 1, 2] as const

/** The two STRONG proofs (either one earns ✓; both are required for ✓✓). */
const STRONG_METHODS: readonly VerificationMethod[] = ['ens', 'world-id'] as const

/** The sign-in category (either satisfies the ✓✓ session requirement). */
const SIGN_IN_METHODS: readonly VerificationMethod[] = ['dynamic', 'oidc'] as const

/**
 * The rung a set of completed methods earns.
 *
 *   ✓✓ — ens AND world-id AND a sign-in (dynamic or OIDC).
 *   ✓  — ens OR world-id.
 *   ○  — anything less (a lone sign-in / on-chain signal stays Connected).
 */
export function rungFor(methods: readonly VerificationMethod[]): LadderRung {
  const hasEns = methods.includes('ens')
  const hasWorld = methods.includes('world-id')
  const hasSignIn = methods.some((m) => SIGN_IN_METHODS.includes(m))
  if (hasEns && hasWorld && hasSignIn) return 2
  if (hasEns || hasWorld) return 1
  return 0
}

/** The single next action the ladder offers (one button, never a menu). */
export interface LadderNextAction {
  /** The method the one button runs. */
  method: VerificationMethod
  /** The button's plain-English label (the component may specialise it). */
  label: string
  /** One line of "why" shown next to the button. */
  hint: string
}

/** Context the chooser needs to pick the friendliest single step. */
export interface LadderContext {
  /**
   * True when the connected wallet already has a recognized primary ENS name
   * (forward==reverse) — then the ENS proof is ONE tap and is preferred.
   */
  hasRecognizedEnsName?: boolean
  /**
   * True when World ID isn't switched on for this deployment (the server said
   * `not_configured`) — then the chooser routes around it instead of dead-ending.
   */
  worldIdUnavailable?: boolean
}

/**
 * EXACTLY ONE next step for the profile, or null when there is nothing useful
 * to offer (already ✓✓, or the only remaining proof is unavailable).
 *
 * Choice order:
 *   1. A missing STRONG proof — at ○ prefer the one-tap option (a recognized
 *      ENS name when present, else World ID); at ✓ the missing one of the two.
 *   2. Both strong proofs done, sign-in missing → confirm the sign-in.
 *   3. ✓✓ (or unreachable) → null.
 */
export function nextLadderAction(
  methods: readonly VerificationMethod[],
  ctx: LadderContext = {},
): LadderNextAction | null {
  if (rungFor(methods) === 2) return null

  const missingStrong = STRONG_METHODS.filter((m) => !methods.includes(m))
  const hasSignIn = methods.some((m) => SIGN_IN_METHODS.includes(m))

  // 1. A strong proof is missing — offer exactly one of them.
  if (missingStrong.length > 0) {
    let pick: VerificationMethod
    if (missingStrong.length === 2) {
      // Nothing strong yet: one-tap first. A recognized primary ENS name is the
      // friendliest single tap; otherwise the World ID scan is one tap too.
      pick = ctx.hasRecognizedEnsName ? 'ens' : ctx.worldIdUnavailable ? 'ens' : 'world-id'
    } else {
      pick = missingStrong[0]
    }
    if (pick === 'world-id' && ctx.worldIdUnavailable) {
      // World ID is off on this deploy: route to the other useful step instead
      // of dead-ending — the sign-in still moves the profile forward.
      if (!hasSignIn) return ACTIONS.dynamic
      return null
    }
    return ACTIONS[pick === 'ens' ? 'ens' : 'world-id']
  }

  // 2. Both strong proofs are in — the sign-in confirmation completes ✓✓.
  if (!hasSignIn) return ACTIONS.dynamic

  return null
}

/** The one-button copy per action (plain English, no jargon — non-coder law). */
const ACTIONS: Readonly<Record<'ens' | 'world-id' | 'dynamic', LadderNextAction>> = {
  ens: {
    method: 'ens',
    label: 'Verify your ENS name',
    hint: 'Prove the name that points to this wallet is yours.',
  },
  'world-id': {
    method: 'world-id',
    label: 'Verify you’re a real person',
    hint: 'One tap with World ID — we only learn a yes, never who you are.',
  },
  dynamic: {
    method: 'dynamic',
    label: 'Confirm I’m signed in',
    hint: 'One tap — we confirm your signed-in session and you’re done.',
  },
}
