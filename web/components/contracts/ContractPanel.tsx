'use client'

/**
 * ContractPanel — a GENERIC, ABI-driven read/write surface for ONE shared-rail
 * module. It renders a "Read" button for every `view`/`pure` function and a
 * wallet-gated "Write" button for every state-changing one, straight from the
 * module's committed ABI — so the WHOLE contract surface is reachable without a
 * hand-written panel per module. It is the in-app equivalent of a block
 * explorer's Read/Write Contract tabs, wired to the deployed testnet address and
 * the app's Dynamic wallet.
 *
 * Honesty (law #4): the address is resolved from the broadcast deployments map
 * (never a literal); a module with no address on the live chain renders an
 * explicit "not on this chain yet" and NO buttons — it never fakes a seat. Every
 * write pins the wallet to the panel's chain first, and a revert surfaces by its
 * decoded reason, never as a silent success.
 */
import { useState, type ReactNode } from 'react'
import type { AbiFunction, AbiParameter, Hash } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { getChain } from '@/lib/chains'
import { ensureChain } from '@/lib/live-chain'
import { getPublicClient, getWalletClient } from '@/lib/wallet'
import { getModule, type ResolvedModule } from '@/lib/modules/registry'
import type { ModuleName } from '@/lib/generated/module-abis'
import { formatResult, humanizeError, parseArg } from '@/lib/modules/encode'
import { readModule, writeModule } from '@/lib/modules/call'
import { moduleExplorerUrl } from '@/components/RailModulesCard'
import { SectionCard } from '@/components/ui/SectionCard'
import { TxHashLink } from '@/components/TxHashLink'

/** Truncate an address for display: 0x1234…abcd. */
function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** A placeholder hint for a parameter's input (its type, arrays/tuples as JSON). */
function hintFor(param: AbiParameter): string {
  if (param.type === 'address') return '0x…'
  if (param.type.startsWith('uint') || param.type.startsWith('int')) return '0'
  if (param.type === 'bool') return 'true / false'
  if (param.type.startsWith('bytes')) return '0x…'
  if (param.type.endsWith(']') || param.type.startsWith('tuple')) return `${param.type} as JSON`
  return param.type
}

export function ContractPanel({ name, chainId }: { name: ModuleName; chainId: number }): ReactNode {
  const resolved = getModule(name, chainId)
  if (!resolved) return null

  return (
    <ContractPanelView resolved={resolved} chainId={chainId} chainName={getChain(chainId).name} />
  )
}

/** The resolved, chain-bound panel body (split out so the container stays lean). */
function ContractPanelView({
  resolved,
  chainId,
  chainName,
}: {
  resolved: ResolvedModule
  chainId: number
  chainName: string
}): ReactNode {
  const { meta, parts, address } = resolved
  const explorer = address ? moduleExplorerUrl(chainId, address) : undefined

  return (
    <SectionCard data-contract-panel={meta.name} className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold text-foreground">{meta.label}</h3>
          {address ? (
            explorer ? (
              <a
                href={explorer}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-rail underline-offset-2 hover:underline"
              >
                {short(address)}
              </a>
            ) : (
              <span className="font-mono text-xs text-muted-foreground">{short(address)}</span>
            )
          ) : (
            <span className="rounded-full border border-input px-2 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
              not on {chainName} yet
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{meta.blurb}</p>
      </header>

      {address ? (
        <div className="flex flex-col gap-3">
          <FunctionSection
            title="Read"
            emptyLabel="No read functions."
            fns={parts.reads}
            kind="read"
            address={address}
            resolved={resolved}
            chainId={chainId}
            chainName={chainName}
          />
          <FunctionSection
            title="Write"
            emptyLabel="No write functions."
            fns={parts.writes}
            kind="write"
            address={address}
            resolved={resolved}
            chainId={chainId}
            chainName={chainName}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          This module isn’t deployed on {chainName} in this build — it appears here and becomes
          callable the moment it lands on a chain you’re connected to.
        </p>
      )}
    </SectionCard>
  )
}

/** A collapsible group of same-kind functions (all reads, or all writes). */
function FunctionSection({
  title,
  emptyLabel,
  fns,
  kind,
  address,
  resolved,
  chainId,
  chainName,
}: {
  title: string
  emptyLabel: string
  fns: readonly AbiFunction[]
  kind: 'read' | 'write'
  address: `0x${string}`
  resolved: ResolvedModule
  chainId: number
  chainName: string
}): ReactNode {
  return (
    <details className="group rounded-xl border border-border bg-background/40">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium text-foreground">
        <span>
          {title} <span className="text-muted-foreground">({fns.length})</span>
        </span>
        <span className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="flex flex-col divide-y divide-border border-t border-border">
        {fns.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          fns.map((fn) => (
            <FunctionRow
              key={`${fn.name}(${fn.inputs.map((i) => i.type).join(',')})`}
              fn={fn}
              kind={kind}
              address={address}
              resolved={resolved}
              chainId={chainId}
              chainName={chainName}
            />
          ))
        )}
      </div>
    </details>
  )
}

/**
 * One function: its inputs (+ a `value` field when payable), a Read/Write
 * button, and the result / tx hash / error it produced. All state is local to
 * the row so 200 rows don't share one giant reducer.
 */
function FunctionRow({
  fn,
  kind,
  address,
  resolved,
  chainId,
  chainName,
}: {
  fn: AbiFunction
  kind: 'read' | 'write'
  address: `0x${string}`
  resolved: ResolvedModule
  chainId: number
  chainName: string
}): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const isPayable = fn.stateMutability === 'payable'
  const [inputs, setInputs] = useState<string[]>(() => fn.inputs.map(() => ''))
  const [payableValue, setPayableValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<Hash | null>(null)
  const [error, setError] = useState<string | null>(null)

  function setArg(i: number, v: string): void {
    setInputs((prev) => prev.map((x, idx) => (idx === i ? v : x)))
  }

  /** Coerce every input, throwing the first friendly parse error. */
  function buildArgs(): unknown[] {
    return fn.inputs.map((param, i) => parseArg(param, inputs[i] ?? ''))
  }

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    setResult(null)
    setTxHash(null)
    try {
      const args = buildArgs()
      if (kind === 'read') {
        const client = getPublicClient(chainId)
        const value = await readModule(client, address, resolved.abi, fn.name, args)
        setResult(formatResult(value))
      } else {
        let walletClient = await getWalletClient(primaryWallet)
        // Pin the wallet to the panel's chain BEFORE submitting (never a
        // wrong-chain tx); re-derive the client after a switch so its chain
        // snapshot matches (the SponsorPanel precedent).
        const switched = await ensureChain(walletClient, chainId)
        if (switched) walletClient = await getWalletClient(primaryWallet)
        const publicClient = getPublicClient(chainId)
        const value = isPayable ? parsePayableValue(payableValue) : undefined
        const hash = await writeModule(
          walletClient,
          publicClient,
          address,
          resolved.abi,
          fn.name,
          args,
          value,
        )
        setTxHash(hash)
      }
    } catch (err) {
      setError(humanizeError(err))
    } finally {
      setBusy(false)
    }
  }

  const busyLabel = kind === 'read' ? 'Reading…' : 'Submitting…'
  const actionLabel = kind === 'read' ? 'Read' : 'Write'

  return (
    <div className="flex flex-col gap-2 px-3 py-3" data-fn={fn.name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="text-xs font-medium text-foreground">{fn.name}</code>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className={`rounded-lg px-3 py-1 text-xs font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${
            kind === 'write'
              ? 'bg-rail text-white hover:opacity-90'
              : 'border border-input bg-background text-foreground hover:border-rail hover:text-rail'
          }`}
        >
          {busy ? busyLabel : actionLabel}
        </button>
      </div>

      {fn.inputs.length > 0 || isPayable ? (
        <div className="flex flex-col gap-1.5">
          {fn.inputs.map((param, i) => (
            <label key={`${param.name ?? ''}-${i}`} className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-muted-foreground">
                {param.name ? `${param.name}: ` : ''}
                {param.type}
              </span>
              <input
                id={`contract-arg-${i}`}
                name={`arg-${i}`}
                autoComplete="off"
                value={inputs[i] ?? ''}
                onChange={(e) => setArg(i, e.target.value)}
                placeholder={hintFor(param)}
                spellCheck={false}
                className="rounded-lg border border-input bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-rail"
              />
            </label>
          ))}
          {isPayable ? (
            <label className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-amber-600">value (wei) — native amount to send</span>
              <input
                id="contract-payable-value"
                name="payable-value"
                autoComplete="off"
                value={payableValue}
                onChange={(e) => setPayableValue(e.target.value)}
                placeholder="0"
                spellCheck={false}
                className="rounded-lg border border-input bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-rail"
              />
            </label>
          ) : null}
        </div>
      ) : null}

      {result !== null ? (
        <pre className="overflow-x-auto rounded-lg bg-secondary px-2 py-1.5 text-[11px] text-foreground">
          {result}
        </pre>
      ) : null}
      {txHash ? (
        <p className="text-[11px] text-muted-foreground">
          Submitted on {chainName}: <TxHashLink chainId={chainId} hash={txHash} />
        </p>
      ) : null}
      {error ? <p className="text-[11px] text-red-600">{error}</p> : null}
    </div>
  )
}

/** Parse the payable `value` field (wei) into a bigint, or throw a clear error. */
function parsePayableValue(raw: string): bigint {
  const s = raw.trim()
  if (s === '') return 0n
  try {
    const v = BigInt(s)
    if (v < 0n) throw new Error('negative')
    return v
  } catch {
    throw new Error('value: enter the native amount to send, in wei (a whole number).')
  }
}
