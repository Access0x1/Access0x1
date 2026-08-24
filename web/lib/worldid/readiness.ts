/**
 * readiness.ts — the honest, SERVER-ONLY answer to "is the World ID seam
 * actually usable, and what exactly is missing?".
 *
 * WHY THIS EXISTS. Every piece of the World ID seam is code-complete and
 * env-gated, and each gate fails soft on its own: `/api/world/sign` answers 503
 * `not_configured`, `resolveGate()` degrades a verified-human checkout to
 * standard, the widget renders a plain "not switched on" line. Fail-soft is the
 * right behaviour in front of a payment — and it is also indistinguishable from
 * a working deployment right up until someone tries to verify. An operator had
 * no way to ask which of six values was the one still blank.
 *
 * This module answers that in one place, in terms of variable NAMES. It reports
 * presence as booleans and names as strings; it NEVER returns a value, a prefix,
 * a length, or any other fingerprint of a credential (secrets law). The action
 * strings are the one exception and they are not secret — they are already
 * public in the client bundle and inside `hash(app_id, action)`.
 *
 * SERVER-ONLY. {@link worldSigningKey} throws when read in a browser by design,
 * so this module must never be imported from a `'use client'` component. The
 * `/api/world/status` route is its only intended caller.
 *
 * LABEL DISCIPLINE (law #4). The label this returns is the label the project is
 * allowed to use in prose. `ready:false` means "built, env-gated" — never
 * "live".
 *
 * The ceiling is "configured", NOT "live", and the difference is the whole point
 * of the law. Every check here reads the ENVIRONMENT: four variables are
 * non-empty and a store URL is set. That is configuration — evidence that a
 * verify COULD complete, never evidence that one DID. "live" is a claim about
 * the world, and no function reading `process.env` can earn it. A completed
 * verify against the Developer Portal is what earns it, and that proof lives
 * outside this module. So the top label this function can return is
 * "configured, unverified", and a human upgrades it after seeing a real proof
 * clear — production being a separate owner decision on top of that.
 */

import {
  isWorldIdConfigured,
  worldAction,
  worldAgentAction,
  worldAgentKitAction,
  worldAppId,
  worldEnvironment,
  worldOperatorAction,
  worldRpId,
  worldSigningKey,
  worldVerifyBase,
  type WorldEnvironment,
} from './config.js'
import { durableStoreRequired, isDurableStoreConfigured } from '../security/replayStore.js'

/**
 * The env var that flips the seam from the staging simulator to production —
 * THE single switch, and an OWNER GATE. It is `NEXT_PUBLIC_`, so Next inlines it
 * at BUILD time: changing it demands a rebuild and redeploy, never a runtime env
 * flip. Production also needs its own separately-registered Developer-Portal app
 * (its own app id, rp id and signing key) and a real World App user, because the
 * staging simulator stops working there.
 */
export const WORLD_PRODUCTION_SWITCH = 'NEXT_PUBLIC_WORLD_ENVIRONMENT' as const

/**
 * The honest label for the seam's current state. Never upgraded without proof.
 *
 * `'live'` is deliberately absent. This module measures env presence, and env
 * presence is configuration, never a completed verify — see the label-discipline
 * note at the top of the file.
 */
export type WorldSeamLabel = 'configured, unverified' | 'built, env-gated'

/** What `/api/world/status` reports. Names and booleans only — never a value. */
export interface WorldReadiness {
  /**
   * True when a verify can actually complete end-to-end: the public app id, the
   * rp id, the server signing key AND a durable nullifier store are all present.
   */
  ready: boolean
  /**
   * The honest label. `ready:false` ⇒ "built, env-gated"; fully wired ⇒
   * "configured, unverified". Never "live" — nothing here observes a verify.
   */
  label: WorldSeamLabel
  /** Staging (the simulator, the default) or production. */
  environment: WorldEnvironment
  /** The Developer-Portal base the current environment verifies against. */
  verifyBase: string
  /** The single env var that switches environment — an owner gate. */
  productionSwitch: typeof WORLD_PRODUCTION_SWITCH
  /** Presence booleans. Never a value, never a prefix, never a length. */
  present: {
    appId: boolean
    rpId: boolean
    signingKey: boolean
    durableNullifierStore: boolean
  }
  /**
   * Nullifier durability — the one-human-per-action guarantee. Without a durable
   * store a claimed nullifier dies with the process and the SAME proof can be
   * replayed; production (and `VERIFY_REQUIRE_DURABLE_STORE=true`) therefore
   * refuses to serve rather than degrade to the in-memory set.
   */
  nullifierStore: {
    durable: boolean
    /** True when this runtime REFUSES the in-memory fallback (503 on verify). */
    required: boolean
    /**
     * `durable` — claims survive a restart.
     * `in-memory-dev` — claims are LOST on restart; replay is possible. Dev only.
     * `fail-closed` — nothing durable and this runtime demands one: verify 503s.
     */
    mode: 'durable' | 'in-memory-dev' | 'fail-closed'
  }
  /** The env var NAMES still blank. Names only — this is the actionable list. */
  missing: string[]
  /** The four distinct action strings (public by design, not secrets). */
  actions: {
    buyer: string
    operator: string
    agent: string
    agentkit: string
  }
}

/**
 * Compute the seam's readiness from the current environment.
 *
 * @returns the full {@link WorldReadiness} report — booleans, names, and the
 *          public action strings. Never a credential value.
 */
export function worldReadiness(): WorldReadiness {
  const appId = worldAppId().startsWith('app_')
  const rpId = worldRpId().length > 0
  const signingKey = worldSigningKey().length > 0
  const durable = isDurableStoreConfigured()
  const required = durableStoreRequired()

  const missing: string[] = []
  if (!appId) missing.push('NEXT_PUBLIC_WORLD_APP_ID')
  if (!rpId) missing.push('WORLD_RP_ID')
  if (!signingKey) missing.push('WORLD_SIGNING_KEY')
  if (!durable) missing.push('NULLIFIER_STORE_URL')

  // A durable nullifier store is part of READY, not an optional extra: without
  // it the one-human-per-action promise the gate exists to make does not hold.
  const ready = appId && rpId && signingKey && durable

  return {
    ready,
    // Machine-computed from env presence alone, so the top rung is "configured",
    // never "live". Upgrading on four non-empty variables is a label upgrade
    // without proof, which is precisely what law #4 forbids.
    label: ready ? 'configured, unverified' : 'built, env-gated',
    environment: worldEnvironment(),
    verifyBase: worldVerifyBase(),
    productionSwitch: WORLD_PRODUCTION_SWITCH,
    present: { appId, rpId, signingKey, durableNullifierStore: durable },
    nullifierStore: {
      durable,
      required,
      mode: durable ? 'durable' : required ? 'fail-closed' : 'in-memory-dev',
    },
    missing,
    actions: {
      buyer: worldAction(),
      operator: worldOperatorAction(),
      agent: worldAgentAction(),
      agentkit: worldAgentKitAction(),
    },
  }
}

/**
 * Is the seam configured enough to MOUNT the gate (the check `resolveGate` and
 * the widget already make)? Deliberately weaker than {@link worldReadiness}'s
 * `ready`: mounting needs only the public pair, while completing a verify also
 * needs the signing key and a durable store. Re-exported here so a caller
 * reasoning about readiness sees both thresholds side by side.
 */
export { isWorldIdConfigured }
