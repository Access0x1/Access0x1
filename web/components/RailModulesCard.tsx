'use client'

import type { ReactNode } from 'react'
import { DEPLOYMENTS } from '@/lib/deployments'
import { SUPPORTED_CHAINS } from '@/lib/chains'

/** One shared rail module: display name + its on-chain address. */
export interface RailModule {
  name: string
  address: string
}

/**
 * The SHARED rail modules deployed on `chainId`, read from the generated
 * deployments map (lib/deployments.ts — broadcast ground truth, never a
 * guessed address). UUPS chains list `<Name>.impl` + `<Name>.proxy` pairs; the
 * PROXY is the live address a merchant interacts with, so we keep proxies
 * (stripping the suffix) and plain single-address entries, and drop `.impl`
 * rows and the bare ERC1967Proxy artifact. A chain with no recorded
 * deployments returns [] — the card then simply doesn't list modules, it never
 * invents them.
 */
export function sharedModulesFor(chainId: number): RailModule[] {
  const chain = DEPLOYMENTS.find((c) => c.chainId === chainId)
  if (!chain) return []
  const modules: RailModule[] = []
  for (const d of chain.deployments) {
    if (d.contractName.endsWith('.impl')) continue
    if (d.contractName === 'ERC1967Proxy') continue
    modules.push({ name: d.contractName.replace(/\.proxy$/, ''), address: d.address })
  }
  return modules
}

/** The block-explorer ADDRESS url on `chainId`, or undefined when no explorer
 *  is known for that chain (e.g. Arc) — the caller then renders plain text,
 *  never an invented link (law #4; the DeploymentsView precedent). */
export function moduleExplorerUrl(chainId: number, address: string): string | undefined {
  const explorer = DEPLOYMENTS.find((c) => c.chainId === chainId)?.explorer
  return explorer ? `${explorer}/address/${address}` : undefined
}

/** Human chain name: the app's chain registry first, then the deployments
 *  map's recorded name, then the honest numeric fallback. */
export function chainDisplayName(chainId: number): string {
  return (
    SUPPORTED_CHAINS.find((c) => c.id === chainId)?.name ??
    DEPLOYMENTS.find((c) => c.chainId === chainId)?.name ??
    `chain ${chainId}`
  )
}

/** Truncate an address for display: 0x1234…abcd. */
function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * RailModulesCard — after a registration, show the merchant WHAT they now sit
 * on: their merchantId and the SHARED module addresses on the chain the seat
 * actually landed on (the live chain at registration time), each linked to
 * that chain's block explorer when one is known.
 */
export function RailModulesCard({
  chainId,
  merchantId,
}: {
  /** The chain the registration landed on (RegisterResult.chainId). */
  chainId: number
  /** The registered merchant id, as a string. */
  merchantId: string
}): ReactNode {
  const modules = sharedModulesFor(chainId)

  return (
    <div className="flex flex-col gap-3" data-testid="rail-modules">
      <div>
        <h3 className="text-sm font-semibold text-ink">
          Merchant #{merchantId} on {chainDisplayName(chainId)}
        </h3>
        <p className="text-xs text-muted-foreground">
          Your seat lives on the shared rail below — the same audited contracts every business on
          this network uses.
        </p>
      </div>
      {modules.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {modules.map((m) => {
            const url = moduleExplorerUrl(chainId, m.address)
            return (
              <li key={m.name} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="font-medium text-ink">{m.name}</span>
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-rail underline-offset-2 hover:underline"
                  >
                    {short(m.address)}
                  </a>
                ) : (
                  <span className="font-mono text-muted-foreground">{short(m.address)}</span>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          No recorded module addresses for this network in this build.
        </p>
      )}
    </div>
  )
}
