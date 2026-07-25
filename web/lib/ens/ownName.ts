/**
 * ownName.ts — the "Own your name" step engine.
 *
 * The UI gets a state machine, not a pile of booleans, because ENS registration
 * has hard ordering rules and every wrong ordering reverts on-chain with the
 * buyer's gas spent:
 *
 *   have-name? → pick → quote → commit(tx1) → WAIT(60s..24h) → register(tx2) → done
 *
 * What this module enforces:
 *   - "if they don't have": a wallet with a verified primary name skips the
 *     flow entirely (the caller feeds `hasPrimaryName` from usePrimaryEnsName).
 *   - The register step is OFFERED only after minCommitmentAge + a safety
 *     margin has elapsed, and REFUSED after maxCommitmentAge (the commitment
 *     is dead on-chain; the only honest path is a fresh commit).
 *   - The commitment SECRET + params survive a page refresh: they persist to
 *     an injected Storage. Losing the secret after tx1 doesn't lose funds
 *     (commit is gas-only), but it forces a re-commit — so we don't lose it.
 *   - The registering wallet must equal the committed owner. The owner is
 *     baked into the commitment hash; a switched wallet can only produce a
 *     doomed tx2, so the engine blocks it client-side with honest copy.
 *
 * Pure + injected (clock, storage): fully unit-testable, no timers, no DOM.
 */

import type { Address, Hex } from 'viem'

import {
  COMMITMENT_SAFETY_MARGIN_S,
  FALLBACK_MAX_COMMITMENT_AGE_S,
  FALLBACK_MIN_COMMITMENT_AGE_S,
} from './registrar'

/** Every UI step, in protocol order. */
export type OwnNameStep =
  | 'already_named' // wallet has a primary name — nothing to buy
  | 'pick' // choosing/validating a label
  | 'quoted' // available + priced; ready to commit
  | 'committing' // tx1 in flight
  | 'waiting' // commitment mined; inside the mandatory window
  | 'ready_to_register' // window open; tx2 may be sent
  | 'registering' // tx2 in flight
  | 'done' // name owned
  | 'expired' // maxCommitmentAge passed; must re-commit

/** A commitment that survived tx1 — everything tx2 must replay exactly. */
export interface PendingCommitment {
  label: string
  owner: Address
  durationSeconds: string // bigint as string — JSON-safe
  secret: Hex
  resolver: Address
  data: readonly Hex[]
  reverseRecord: boolean
  commitment: Hex
  chainId: number
  controller: Address
  /** Block timestamp of the commit tx, in ms (client clock only as fallback). */
  committedAtMs: number
  /** The controller's window, captured at commit time. */
  minAgeS: number
  maxAgeS: number
}

/** Storage seam — localStorage in the browser, a Map-backed stub in tests. */
export interface PendingStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** One pending registration per (chain, wallet): a second name is a second flow. */
export function pendingKey(chainId: number, owner: Address): string {
  return `access0x1.ens.pending.${chainId}.${owner.toLowerCase()}`
}

/** Persist a mined commitment so a refresh can't strand it. */
export function savePending(store: PendingStore, p: PendingCommitment): void {
  store.setItem(pendingKey(p.chainId, p.owner), JSON.stringify(p))
}

/**
 * Load the pending commitment for this wallet, dropping it when it can no
 * longer be registered (expired) or when it doesn't parse. Never throws.
 */
export function loadPending(
  store: PendingStore,
  chainId: number,
  owner: Address,
  nowMs: number,
): PendingCommitment | null {
  const raw = store.getItem(pendingKey(chainId, owner))
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as PendingCommitment
    if (
      typeof p?.label !== 'string' ||
      typeof p?.secret !== 'string' ||
      typeof p?.committedAtMs !== 'number'
    ) {
      store.removeItem(pendingKey(chainId, owner))
      return null
    }
    if (commitmentPhase(p, nowMs) === 'expired') {
      store.removeItem(pendingKey(chainId, owner))
      return null
    }
    return p
  } catch {
    store.removeItem(pendingKey(chainId, owner))
    return null
  }
}

/** Forget a pending commitment (registered, or deliberately abandoned). */
export function clearPending(store: PendingStore, chainId: number, owner: Address): void {
  store.removeItem(pendingKey(chainId, owner))
}

/** Where a commitment stands inside the on-chain window. */
export type CommitmentPhase = 'waiting' | 'open' | 'expired'

/**
 * The single timing authority: register is offered ONLY in 'open'.
 * 'waiting'  — before minAge + safety margin (an early tx2 reverts).
 * 'open'     — inside [minAge+margin, maxAge−margin].
 * 'expired'  — past maxAge (minus margin): the commitment is unusable.
 */
export function commitmentPhase(
  p: Pick<PendingCommitment, 'committedAtMs' | 'minAgeS' | 'maxAgeS'>,
  nowMs: number,
): CommitmentPhase {
  const minAgeS = Number.isFinite(p.minAgeS) && p.minAgeS > 0 ? p.minAgeS : FALLBACK_MIN_COMMITMENT_AGE_S
  const maxAgeS = Number.isFinite(p.maxAgeS) && p.maxAgeS > 0 ? p.maxAgeS : FALLBACK_MAX_COMMITMENT_AGE_S
  const elapsedS = (nowMs - p.committedAtMs) / 1000
  if (elapsedS < minAgeS + COMMITMENT_SAFETY_MARGIN_S) return 'waiting'
  if (elapsedS > maxAgeS - COMMITMENT_SAFETY_MARGIN_S) return 'expired'
  return 'open'
}

/** Seconds until the register step opens (for the countdown UI). 0 when open. */
export function secondsUntilOpen(
  p: Pick<PendingCommitment, 'committedAtMs' | 'minAgeS' | 'maxAgeS'>,
  nowMs: number,
): number {
  const minAgeS = Number.isFinite(p.minAgeS) && p.minAgeS > 0 ? p.minAgeS : FALLBACK_MIN_COMMITMENT_AGE_S
  const openAtMs = p.committedAtMs + (minAgeS + COMMITMENT_SAFETY_MARGIN_S) * 1000
  return Math.max(0, Math.ceil((openAtMs - nowMs) / 1000))
}

/**
 * Guard for tx2: the connected wallet must be the committed owner. The owner
 * is inside the commitment hash — any other wallet's register() is a
 * guaranteed revert, so refuse it before it costs gas.
 */
export function canRegisterFrom(p: Pick<PendingCommitment, 'owner'>, connected: Address | undefined): boolean {
  return !!connected && connected.toLowerCase() === p.owner.toLowerCase()
}

/**
 * Resolve the current step from facts. This is the ONE place step order is
 * decided; the UI renders it and never invents its own ordering.
 */
export function currentStep(facts: {
  hasPrimaryName: boolean
  pending: PendingCommitment | null
  nowMs: number
  txInFlight?: 'commit' | 'register'
  registered?: boolean
}): OwnNameStep {
  if (facts.registered) return 'done'
  if (facts.hasPrimaryName) return 'already_named'
  if (facts.txInFlight === 'commit') return 'committing'
  if (facts.txInFlight === 'register') return 'registering'
  if (!facts.pending) return 'pick'
  const phase = commitmentPhase(facts.pending, facts.nowMs)
  if (phase === 'waiting') return 'waiting'
  if (phase === 'expired') return 'expired'
  return 'ready_to_register'
}
