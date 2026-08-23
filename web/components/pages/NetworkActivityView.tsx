'use client'

/**
 * NetworkActivityView — the network-wide "top merchants by indexed volume" page.
 * Public, wallet-free (like `/deployments`): reads ONLY the shared subgraph via
 * `lib/graph-analytics.ts`, never a merchant's own dashboard state. Off the
 * money path — the seam is env-gated and fail-soft, exactly like the existing
 * `DashboardView` receipts read, with one deliberate difference: there is NO
 * on-chain fallback here, because a network-wide ranking cannot be reconstructed
 * from a bounded per-contract `getLogs` window (see graph-analytics.ts's header
 * comment). So the three honest states this page can show are:
 *
 *   - DORMANT   — no subgraph configured. Says so plainly; never attempts a
 *                 doomed chain-side reconstruction, never shows fake rows.
 *   - ERROR     — configured, but the last read failed (indexer unreachable /
 *                 bad response). Neutral retry, no fabricated numbers.
 *   - READY     — real rows from the index, labeled "as of block N" so no
 *                 count on this page is ever a hand-claim.
 *
 * This is the surface for the shared-index angle: ONE shared subgraph is the
 * canonical payment-data layer every integrator reading this rail could query
 * for the same ranking, instead of each standing up its own indexer.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  fetchMerchantLeaderboard,
  isNetworkLeaderboardActive,
  type NetworkLeaderboard,
} from '@/lib/graph-analytics'
import { amount8ToUsd } from '@/lib/quote'
import { PageHeading } from '@/components/ui/PageHeading'
import { SectionCard } from '@/components/ui/SectionCard'

type LoadState =
  | { status: 'dormant' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: NetworkLeaderboard }

function formatTimestamp(unixSeconds: bigint): string {
  if (unixSeconds === 0n) return '—'
  return new Date(Number(unixSeconds) * 1000).toLocaleString()
}

export function NetworkActivityView(): ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const load = useCallback(async () => {
    if (!isNetworkLeaderboardActive()) {
      setState({ status: 'dormant' })
      return
    }
    setState({ status: 'loading' })
    const data = await fetchMerchantLeaderboard()
    if (data === null) {
      setState({ status: 'error' })
      return
    }
    setState({ status: 'ready', data })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-16">
      <PageHeading
        eyebrow="The shared rail"
        title="Network activity"
      />
      <p className="text-sm text-muted-foreground">
        Top merchants by indexed USD volume across the whole Access0x1 rail — read from the shared
        subgraph, the same canonical source every integrator reading this rail would query. Off the
        money path: this page never gates or affects settlement.
      </p>

      {state.status === 'dormant' ? (
        <SectionCard data-network-activity="dormant" className="bg-secondary/50">
          <p className="text-sm text-muted-foreground">
            The Graph indexer isn&apos;t configured for this deployment. Set{' '}
            <code className="rounded bg-secondary px-1 py-0.5 text-xs">
              NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL
            </code>{' '}
            to a deployed Access0x1 subgraph query URL to enable this view — nothing on the money
            path changes either way.
          </p>
        </SectionCard>
      ) : null}

      {state.status === 'loading' ? (
        <div className="h-40 animate-pulse rounded-xl bg-secondary" data-network-activity="loading" />
      ) : null}

      {state.status === 'error' ? (
        <SectionCard data-network-activity="error" className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t reach the subgraph just now — the indexed view is temporarily unavailable.
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="self-start rounded-lg border border-input px-3 py-1.5 text-sm hover:bg-secondary"
          >
            Retry
          </button>
        </SectionCard>
      ) : null}

      {state.status === 'ready' ? (
        <div className="flex flex-col gap-3" data-network-activity="ready">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {state.data.asOfBlock !== null
                ? `As of block ${state.data.asOfBlock.toString()}`
                : 'Indexer height unavailable'}
            </span>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-lg border border-input px-3 py-1.5 text-sm hover:bg-secondary"
            >
              Refresh
            </button>
          </div>

          {state.data.hasIndexingErrors ? (
            <p
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
              data-testid="indexing-errors-warning"
            >
              The subgraph reports indexing errors — this ranking may be incomplete or stale.
            </p>
          ) : null}

          {state.data.merchants.length === 0 ? (
            <p className="text-sm text-muted-foreground">No merchant activity indexed yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-2 font-medium">#</th>
                  <th className="py-2 font-medium">Merchant</th>
                  <th className="py-2 font-medium">Payments</th>
                  <th className="py-2 font-medium">Total (USD)</th>
                  <th className="py-2 font-medium">Last payment</th>
                </tr>
              </thead>
              <tbody>
                {state.data.merchants.map((m, i) => (
                  <tr key={m.merchantId.toString()} className="border-b border-border">
                    <td className="py-2 font-mono text-xs text-muted-foreground">{i + 1}</td>
                    <td className="py-2 font-mono text-xs">#{m.merchantId.toString()}</td>
                    <td className="py-2">{m.paymentCount.toString()}</td>
                    <td className="py-2">${amount8ToUsd(m.totalUsd8)}</td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {formatTimestamp(m.lastPaymentAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </main>
  )
}
