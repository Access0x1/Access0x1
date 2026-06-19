'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPublicClient, http, type Address } from 'viem'
import { DEPLOYMENTS, type ChainDeployments } from '@/lib/deployments'
import { diffContract, type DiffStatus } from '@/lib/bytecodeDiff'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * @file DeploymentsView.tsx — the owner's "code-diff" deployment view.
 *
 * Per chain × contract it reads the ON-CHAIN runtime code (`getCode`) against
 * that chain's public RPC and compares it (via {@link diffContract}) to the
 * CURRENT build fingerprint — so a glance tells the owner what is up-to-date
 * (MATCHES), what needs a redeploy (DRIFTED, made visually loud), what was never
 * deployed (NOT-DEPLOYED), and what address went dark (NO-CODE). Every read is
 * client-side and best-effort: an unreachable RPC degrades that chain's cells to
 * "unreachable" and never crashes the page.
 */

/** A reachability/verification state for one contract cell. */
type CellStatus = DiffStatus | 'LOADING' | 'UNREACHABLE'

/** One contract row within a chain group. */
interface ContractRow {
  contractName: string
  address: Address
  status: CellStatus
}

/** Resolve the RPC url for a chain: a per-chain env override, else the vendored
 *  public fallback. Returns undefined when neither is known (the chain's cells
 *  then read "unreachable" rather than guessing an endpoint). */
function rpcUrlFor(chain: ChainDeployments): string | undefined {
  const fromEnv = process.env[`NEXT_PUBLIC_RPC_URL_${chain.chainId}`]
  return fromEnv ?? chain.rpc
}

/** The block-explorer ADDRESS url for a chain, or undefined when no explorer is
 *  known — the address then renders as plain monospace text (law #4). */
function explorerAddressUrl(chain: ChainDeployments, address: string): string | undefined {
  return chain.explorer ? `${chain.explorer}/address/${address}` : undefined
}

/** Truncate an address for display: 0x1234…abcd. */
function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** Map a cell status to a Badge variant + label. DRIFTED is the loud one. */
function statusBadge(status: CellStatus): ReactNode {
  switch (status) {
    case 'MATCHES':
      return <Badge variant="success">Matches</Badge>
    case 'DRIFTED':
      return (
        <Badge variant="destructive" className="font-bold uppercase tracking-wide">
          Drifted
        </Badge>
      )
    case 'NO-CODE':
      return <Badge variant="outline">No code</Badge>
    case 'NOT-DEPLOYED':
      return <Badge variant="secondary">Not deployed</Badge>
    case 'UNKNOWN':
      return <Badge variant="outline">Unbuilt</Badge>
    case 'UNREACHABLE':
      return <Badge variant="outline">Unreachable</Badge>
    case 'LOADING':
    default:
      return <Badge variant="secondary">Checking…</Badge>
  }
}

/** Read every contract on one chain and resolve its status. RPC/`getCode`
 *  failures degrade the whole chain's rows to UNREACHABLE (best-effort, no
 *  throw). A per-contract failure marks only that contract unreachable. */
async function verifyChain(chain: ChainDeployments): Promise<ContractRow[]> {
  const rows: ContractRow[] = chain.deployments.map((d) => ({
    contractName: d.contractName,
    address: d.address as Address,
    status: 'LOADING' as CellStatus,
  }))

  const rpcUrl = rpcUrlFor(chain)
  if (!rpcUrl) {
    return rows.map((r) => ({ ...r, status: 'UNREACHABLE' }))
  }

  let client
  try {
    client = createPublicClient({ transport: http(rpcUrl) })
  } catch {
    return rows.map((r) => ({ ...r, status: 'UNREACHABLE' }))
  }

  return Promise.all(
    rows.map(async (r): Promise<ContractRow> => {
      try {
        const code = await client.getCode({ address: r.address })
        return { ...r, status: diffContract(r.contractName, code) }
      } catch {
        return { ...r, status: 'UNREACHABLE' }
      }
    }),
  )
}

/** Tally cell statuses for the summary line. */
function summarize(rowsByChain: Record<number, ContractRow[]>): Record<CellStatus, number> {
  const counts: Record<CellStatus, number> = {
    MATCHES: 0,
    DRIFTED: 0,
    'NOT-DEPLOYED': 0,
    'NO-CODE': 0,
    UNKNOWN: 0,
    UNREACHABLE: 0,
    LOADING: 0,
  }
  for (const rows of Object.values(rowsByChain)) {
    for (const r of rows) counts[r.status] += 1
  }
  return counts
}

export function DeploymentsView(): ReactNode {
  const [rowsByChain, setRowsByChain] = useState<Record<number, ContractRow[]>>({})
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    // Seed every chain's rows as LOADING so the table renders immediately, then
    // fill each chain in as its reads resolve.
    setRowsByChain(
      Object.fromEntries(
        DEPLOYMENTS.map((c) => [
          c.chainId,
          c.deployments.map((d) => ({
            contractName: d.contractName,
            address: d.address as Address,
            status: 'LOADING' as CellStatus,
          })),
        ]),
      ),
    )
    await Promise.all(
      DEPLOYMENTS.map(async (chain) => {
        const rows = await verifyChain(chain)
        setRowsByChain((prev) => ({ ...prev, [chain.chainId]: rows }))
      }),
    )
    setLoading(false)
    setLastUpdated(Date.now())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const counts = useMemo(() => summarize(rowsByChain), [rowsByChain])

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-16">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Deployments</h1>
          <p className="text-sm text-muted-foreground">
            Deployed bytecode vs. current source build, per chain × contract.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Checking…' : 'Re-check'}
        </button>
      </header>

      {/* Legend — one line, every status the table can show. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          {statusBadge('MATCHES')} deployed == current source
        </span>
        <span className="inline-flex items-center gap-1.5">
          {statusBadge('DRIFTED')} differs — needs redeploy
        </span>
        <span className="inline-flex items-center gap-1.5">
          {statusBadge('NOT-DEPLOYED')} no address on this chain
        </span>
        <span className="inline-flex items-center gap-1.5">
          {statusBadge('NO-CODE')} address has no bytecode
        </span>
        <span className="inline-flex items-center gap-1.5">
          {statusBadge('UNREACHABLE')} RPC could not be read
        </span>
      </div>

      {/* Summary counts. DRIFTED is surfaced first + emphasized — it is the
          redeploy signal the owner is scanning for. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={
            counts.DRIFTED > 0
              ? 'rounded-md bg-destructive/15 px-2 py-1 font-semibold text-destructive'
              : 'rounded-md bg-secondary px-2 py-1 text-muted-foreground'
          }
        >
          {counts.DRIFTED} drifted
        </span>
        <span className="rounded-md bg-secondary px-2 py-1 text-muted-foreground">
          {counts.MATCHES} up to date
        </span>
        <span className="rounded-md bg-secondary px-2 py-1 text-muted-foreground">
          {counts['NO-CODE']} no-code
        </span>
        <span className="rounded-md bg-secondary px-2 py-1 text-muted-foreground">
          {counts.UNREACHABLE} unreachable
        </span>
        {lastUpdated !== null ? (
          <span className="ml-auto text-xs text-muted-foreground">
            checked {new Date(lastUpdated).toLocaleTimeString()}
          </span>
        ) : null}
      </div>

      {/* One card per chain. */}
      {DEPLOYMENTS.map((chain) => {
        const rows = rowsByChain[chain.chainId] ?? []
        const drifted = rows.some((r) => r.status === 'DRIFTED')
        return (
          <Card
            key={chain.chainId}
            className={drifted ? 'border-destructive/60' : undefined}
          >
            <CardHeader>
              <CardTitle className="flex items-baseline gap-2">
                <span>{chain.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  chain {chain.chainId}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-2 font-medium">Contract</th>
                    <th className="py-2 font-medium">Address</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const url = explorerAddressUrl(chain, r.address)
                    return (
                      <tr
                        key={`${chain.chainId}-${r.contractName}`}
                        className={
                          r.status === 'DRIFTED'
                            ? 'border-b border-border bg-destructive/10'
                            : 'border-b border-border'
                        }
                      >
                        <td className="py-2 font-medium">{r.contractName}</td>
                        <td className="py-2 font-mono text-xs">
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary underline-offset-2 hover:underline"
                            >
                              {shortAddr(r.address)}
                            </a>
                          ) : (
                            <span>{shortAddr(r.address)}</span>
                          )}
                        </td>
                        <td className="py-2">{statusBadge(r.status)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )
      })}
    </main>
  )
}
