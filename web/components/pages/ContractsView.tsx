'use client'

/**
 * ContractsView — the rail console. Lists EVERY shared-rail module (grouped by
 * what it does), each with a generic read/write panel wired to the deployed
 * testnet address. It's the "interact with the smart contracts" surface: pick a
 * chain, connect a wallet, and call any function on any module directly.
 *
 * The chain is chosen HERE (defaulting to the connected wallet's chain when it's
 * a supported mirror chain) and passed to every panel, so reads and writes hit
 * ONE chain the whole page agrees on. The module list is the complete catalog;
 * modules not yet on the chosen chain show honestly as "not on this chain yet".
 */
import { useMemo, useState, type ReactNode } from 'react'
import { getDefaultChainId } from '@/lib/chains'
import { useLiveChain, writableChains } from '@/lib/live-chain'
import { groupByCategory, listModules, liveCount } from '@/lib/modules/registry'
import { ContractPanel } from '@/components/contracts/ContractPanel'
import { ConnectButton } from '@/components/ConnectButton'
import { PageHeading } from '@/components/ui/PageHeading'

export function ContractsView(): ReactNode {
  const live = useLiveChain()
  const chains = useMemo(() => writableChains(), [])

  // Default to the connected wallet's chain when it's a supported mirror chain,
  // else the app default (Arc). A wallet on an unsupported chain still lands on a
  // real, readable chain rather than an empty page.
  const defaultChainId =
    live.isSupported && live.chainId !== null ? live.chainId : getDefaultChainId()
  const [chainId, setChainId] = useState<number>(defaultChainId)

  const modules = useMemo(() => listModules(chainId), [chainId])
  const groups = useMemo(() => groupByCategory(modules), [modules])
  const live_ = liveCount(modules)
  const chainName = chains.find((c) => c.id === chainId)?.name ?? `chain ${chainId}`

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeading eyebrow="Rail console" title="Interact with the contracts" />
        <ConnectButton variant="ghost" />
      </div>

      <p className="text-sm text-muted-foreground">
        Every module on the shared Access0x1 rail, callable directly. Reads run against the chain’s
        public RPC; writes go through your connected wallet. <strong className="text-foreground">Testnet only</strong> —
        a write submits a real transaction to the selected testnet.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Chain</span>
          <select
            id="contracts-chain"
            name="chain"
            autoComplete="off"
            value={chainId}
            onChange={(e) => setChainId(Number(e.target.value))}
            className="rounded-lg border border-input bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-rail"
          >
            {chains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted-foreground">
          {live_} of {modules.length} modules live on {chainName}
        </span>
      </div>

      {groups.map((group) => (
        <section key={group.category} className="flex flex-col gap-3">
          <h2 className="text-xs font-medium uppercase tracking-widest text-rail">
            {group.category}
          </h2>
          <div className="flex flex-col gap-3">
            {group.modules.map((m) => (
              <ContractPanel key={m.meta.name} name={m.meta.name} chainId={chainId} />
            ))}
          </div>
        </section>
      ))}
    </main>
  )
}
