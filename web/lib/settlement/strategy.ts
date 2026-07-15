/**
 * settlement/strategy.ts — the settlement-strategy seam.
 *
 * Today every charge settles DIRECTLY: one on-chain pay per charge (the
 * `Access0x1Router.payToken` path, and the per-request settle on the priced
 * routes). That is {@link directStrategy}, the default everywhere.
 *
 * This seam exists so a future BATCHED strategy — one that meters many small
 * charges off-chain and net-settles them in a SINGLE on-chain pay — can drop in
 * WITHOUT touching call sites: implement {@link SettlementStrategy}, register it
 * with {@link registerSettlementStrategy}, and point
 * `NEXT_PUBLIC_SETTLEMENT_STRATEGY` at its id. Nothing here moves money; a
 * strategy only DECIDES the SHAPE of a settlement (one pay, or one netted pay for
 * many charges) and hands that plan to the existing money path. Default: direct.
 *
 * Pure + dependency-free on purpose, so the resolution logic is unit-testable and
 * safe to import from anywhere (no viem, no wallet, no network).
 */

/** A single charge to settle: who it credits, how much (USD 8-dec), and its ref. */
export interface Charge {
  /** The merchant/seat the charge credits (router merchantId). */
  readonly merchantId: bigint
  /** USD amount in 8 decimals — the router's pricing unit. */
  readonly usdAmount8: bigint
  /** Opaque order reference (bytes32). */
  readonly orderId: `0x${string}`
}

/** How a set of charges will be settled on-chain. */
export interface SettlementPlan {
  /** `direct` today; a registered strategy may introduce other modes (e.g. batched). */
  readonly mode: string
  /** The charges this plan settles — one for `direct`, many for a batch. */
  readonly charges: readonly Charge[]
}

/** A pluggable way to shape charges into an on-chain settlement. */
export interface SettlementStrategy {
  /** Stable id, matched against `NEXT_PUBLIC_SETTLEMENT_STRATEGY`. */
  readonly id: string
  /** Shape ONE charge into a plan. `direct` returns a single-charge plan. */
  plan(charge: Charge): SettlementPlan
}

/** The default: settle each charge on its own, immediately — one pay per charge. */
export const directStrategy: SettlementStrategy = {
  id: 'direct',
  plan(charge) {
    return { mode: 'direct', charges: [charge] }
  },
}

/** The strategy registry, seeded with `direct`. */
const registry = new Map<string, SettlementStrategy>([[directStrategy.id, directStrategy]])

/**
 * Register a settlement strategy — the drop-in point for a future batched
 * settlement. Registering does NOT activate it; `NEXT_PUBLIC_SETTLEMENT_STRATEGY`
 * selects the active one, so a registered-but-unselected strategy is inert.
 */
export function registerSettlementStrategy(strategy: SettlementStrategy): void {
  registry.set(strategy.id, strategy)
}

/** The configured strategy id from env, defaulting to `direct` when unset/blank. */
export function configuredStrategyId(): string {
  const raw = (process.env.NEXT_PUBLIC_SETTLEMENT_STRATEGY ?? '').trim()
  return raw.length > 0 ? raw : directStrategy.id
}

/**
 * Resolve the active strategy. Falls back to {@link directStrategy} when the
 * configured id names a strategy that isn't registered — an unknown id must never
 * silently drop settlement; it settles directly (the safe default).
 */
export function resolveSettlementStrategy(): SettlementStrategy {
  return registry.get(configuredStrategyId()) ?? directStrategy
}

/** For tests: is a non-default strategy configured AND registered? */
export function isBatchedSettlementActive(): boolean {
  return resolveSettlementStrategy().id !== directStrategy.id
}
