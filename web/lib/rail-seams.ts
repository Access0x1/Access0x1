/**
 * rail-seams.ts — the ONE place that documents the rail's optional, dormant
 * capability seams and their single activation switch each. Both are OFF by
 * default and fail closed to the safe path; each is designed so turning it on
 * later is a localized change, not a refactor.
 *
 * ── 1. Indexed event source ────────────────────────────────────────────────
 * History/analytics reads (e.g. the dashboard's receipts) prefer an external
 * INDEXER when one is configured, and fail soft to a bounded on-chain read
 * otherwise. The switch is a single env var:
 *
 *     NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL = https://…/graphql
 *
 * Set it and every indexed read routes through the indexer; leave it unset and
 * the app reads bounded windows from the chain RPC. {@link indexedEventSourceUrl}
 * is the accessor; `lib/dashboard-receipts.ts` is the first consumer.
 *
 * ── 2. Settlement strategy ─────────────────────────────────────────────────
 * Charges settle DIRECTLY (one on-chain pay each) by default. A future strategy
 * that meters many charges off-chain and net-settles once registers itself and
 * is selected by:
 *
 *     NEXT_PUBLIC_SETTLEMENT_STRATEGY = <strategy id>
 *
 * See `lib/settlement/strategy.ts`. Unknown/unset → `direct` (never dropped).
 *
 * Neither seam is wired into a money path yet — this module is the map for when
 * they are, so the switch-on stays a one-line change.
 */
import { resolveSettlementStrategy, configuredStrategyId } from './settlement/strategy'

/**
 * The configured indexed-event-source URL, or `undefined` when the seam is
 * dormant (the app then reads bounded windows from the chain RPC). Reads the
 * SAME `NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL` the receipts read uses, so ONE env
 * var switches the whole indexed-read path on at once.
 */
export function indexedEventSourceUrl(): string | undefined {
  const raw = (process.env.NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL ?? '').trim()
  return raw.length > 0 ? raw : undefined
}

/** Whether the indexed event source is configured (the seam is switched on). */
export function isIndexedSourceActive(): boolean {
  return indexedEventSourceUrl() !== undefined
}

/** A snapshot of which optional seams are active — handy for a status/debug view. */
export interface RailSeamStatus {
  readonly indexedSource: boolean
  readonly settlementStrategy: string
}

export function railSeamStatus(): RailSeamStatus {
  return {
    indexedSource: isIndexedSourceActive(),
    settlementStrategy: resolveSettlementStrategy().id,
  }
}

// Re-exported so a call site can read the active settlement id without also
// importing the strategy module directly.
export { configuredStrategyId }
