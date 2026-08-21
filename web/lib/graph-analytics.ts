/**
 * graph-analytics.ts — the network-wide "who's transacting" read: the top
 * merchants by indexed USD volume across the WHOLE shared rail, off the money
 * path. Unlike `dashboard-receipts.ts` (one merchant's history, which a bounded
 * `getLogs` window can still approximate), this has NO on-chain fallback by
 * design: ranking "top N merchants by volume" requires scanning and sorting
 * EVERY merchant's history, which is exactly the unbounded, cross-entity query
 * a `getLogs` window over one contract cannot do without downloading and
 * aggregating the entire event log client-side. This is the capability a
 * shared subgraph adds that per-integrator direct reads structurally can't: the
 * same indexed source every integrator reading this rail would query for the
 * same canonical ranking, instead of each standing up its own indexer.
 *
 * Dormant by default (`NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL` unset ->
 * `fetchMerchantLeaderboard` resolves to `null`, never throws): the seam is
 * ABSENT, not broken, and the caller renders an honest "not configured" state
 * rather than attempting a doomed chain-side reconstruction. Any GraphQL /
 * network / shape error after the URL IS configured also fails soft to `null`
 * so a transient indexer hiccup never crashes an analytics-only view.
 *
 * Every count here is read from the index, never hand-claimed. `asOfBlock` and
 * `hasIndexingErrors` (from the standard Graph Node `_meta` field) are surfaced
 * so the UI can label the data honestly ("as of block N") and flag a degraded
 * indexer instead of silently trusting a subgraph that may be behind or erroring.
 */

// Reuse the ONE existing accessor for the subgraph URL env var rather than
// re-reading `process.env` here — `dashboard-receipts.ts` is the seam's
// original consumer and already owns the trim/blank-is-dormant parsing.
import { subgraphUrl } from './dashboard-receipts'

export interface MerchantSummary {
  merchantId: bigint
  paymentCount: bigint
  totalUsd8: bigint
  lastPaymentAt: bigint
}

export interface NetworkLeaderboard {
  /** Top merchants by totalUsd8, descending. May be shorter than the request limit. */
  merchants: MerchantSummary[]
  /** The indexer's synced block height at query time, or null if `_meta` was absent. */
  asOfBlock: bigint | null
  /** True when the subgraph reports indexing errors — surface, never hide, a degraded index. */
  hasIndexingErrors: boolean
}

export const DEFAULT_LEADERBOARD_LIMIT = 10
// Bound the page size the same way dashboard-receipts.ts bounds its window count —
// a caller can't turn this into an unbounded full-table dump.
const MAX_LEADERBOARD_LIMIT = 50

/**
 * The top `limit` merchants by indexed USD volume, or `null` when the seam is
 * dormant (no subgraph URL configured) OR any GraphQL/network/shape problem
 * occurs. Never throws — this is an analytics-only read, off the money path.
 *
 * @param limit desired row count; clamped into `1..MAX_LEADERBOARD_LIMIT`.
 * @returns the ranked board plus indexer honesty metadata, or `null` when dormant/failed.
 */
export async function fetchMerchantLeaderboard(
  limit: number = DEFAULT_LEADERBOARD_LIMIT,
): Promise<NetworkLeaderboard | null> {
  const url = subgraphUrl()
  if (!url) return null

  const first = Math.max(1, Math.min(limit, MAX_LEADERBOARD_LIMIT))
  try {
    // paymentCount_gt filters out zeroed Merchant rows created only as a
    // load-or-create side effect of some OTHER merchant's aggregate — every
    // row returned here has at least one real indexed PaymentReceived.
    const query = `query NetworkLeaderboard($first: Int!) {
      merchants(
        first: $first
        orderBy: totalUsd8
        orderDirection: desc
        where: { paymentCount_gt: "0" }
      ) {
        merchantId
        paymentCount
        totalUsd8
        lastPaymentAt
      }
      _meta {
        block { number }
        hasIndexingErrors
      }
    }`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { first } }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: {
        merchants?: Array<{
          merchantId: string
          paymentCount: string
          totalUsd8: string
          lastPaymentAt: string
        }>
        _meta?: {
          block?: { number?: number }
          hasIndexingErrors?: boolean
        } | null
      }
      errors?: unknown
    }
    if (json.errors != null || json.data?.merchants == null) return null

    const merchants: MerchantSummary[] = json.data.merchants.map((m) => ({
      merchantId: BigInt(m.merchantId),
      paymentCount: BigInt(m.paymentCount),
      totalUsd8: BigInt(m.totalUsd8),
      lastPaymentAt: BigInt(m.lastPaymentAt),
    }))
    const blockNumber = json.data._meta?.block?.number
    return {
      merchants,
      asOfBlock: typeof blockNumber === 'number' ? BigInt(blockNumber) : null,
      hasIndexingErrors: json.data._meta?.hasIndexingErrors === true,
    }
  } catch {
    return null
  }
}

/** Whether the network-leaderboard seam has a subgraph configured (no chain fallback exists). */
export function isNetworkLeaderboardActive(): boolean {
  return subgraphUrl() !== undefined
}
