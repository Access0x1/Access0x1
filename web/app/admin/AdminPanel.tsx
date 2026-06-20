'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { isAddress, type Address, type Hash, type Hex, type WalletClient } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { getWalletClient } from '@/lib/wallet'
import {
  ADMIN_TESTNET_CHAINS,
  EXAMPLE_REPO_STRING,
  deriveExampleRepoId,
  getAdminChain,
  getAdminPublicClient,
  isAdminTestnetChain,
  adminTxUrl,
  adminAddressUrl,
  validateAnchorInput,
  humanizeAdminRevert,
  deployRegistry,
  claimRepo,
  anchorRelease,
} from '@/lib/admin/provenanceRegistry'

/** Truncate an address/hash for display: 0x1234…abcd. */
function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

/** The lifecycle of one on-chain action: idle → pending → done | error. */
type Phase = 'idle' | 'pending' | 'done' | 'error'

/** The per-action result the panel tracks (the mined tx hash + any error). */
interface ActionState {
  phase: Phase
  txHash?: Hash
  error?: string
}

const IDLE: ActionState = { phase: 'idle' }

/**
 * The owner-admin panel.
 *
 * TESTNET-ONLY. The owner connects their browser wallet, picks one of the four
 * allowed testnets, and runs each owner-gated step as a button they sign in their
 * own wallet — NO keystore, NO server, NO private key in the app:
 *   1. Deploy Access0x1ProvenanceRegistry (viem deployContract).
 *   2. Claim the example repo — claimRepo(repoId).
 *   3. Anchor an example release — anchorRelease(repoId, cid, tag, merkleRoot).
 *
 * Every action shows pending → tx hash → explorer link, and surfaces revert
 * reasons cleanly. The deployed address is held in state for the later steps and
 * can also be pasted manually.
 */
export function AdminPanel(): ReactNode {
  const { primaryWallet, setShowAuthFlow } = useDynamicContext()

  // The owner-selected target testnet (default: the first allowed chain).
  const [chainId, setChainId] = useState<number>(ADMIN_TESTNET_CHAINS[0].chain.id)

  // The registry the later steps act on: filled by a deploy, or pasted manually.
  const [registry, setRegistry] = useState<Address | ''>('')
  const [registryInput, setRegistryInput] = useState('')

  // Anchor-release form fields.
  const [cid, setCid] = useState('')
  const [tag, setTag] = useState('')
  const [merkleRoot, setMerkleRoot] = useState('')

  // Per-action lifecycle state.
  const [deployState, setDeployState] = useState<ActionState>(IDLE)
  const [claimState, setClaimState] = useState<ActionState>(IDLE)
  const [anchorState, setAnchorState] = useState<ActionState>(IDLE)

  const repoId: Hex = useMemo(() => deriveExampleRepoId(), [])
  const onTestnet = isAdminTestnetChain(chainId)
  const activeChain = getAdminChain(chainId)
  const explorer = activeChain?.chain.blockExplorers?.default?.url ?? null

  // The registry the actions use: a confirmed deploy result, else a valid pasted address.
  const effectiveRegistry: Address | null = useMemo(() => {
    if (registry) return registry
    const trimmed = registryInput.trim()
    return isAddress(trimmed) ? (trimmed as Address) : null
  }, [registry, registryInput])

  /**
   * Ensure the connected browser wallet is on the owner-selected testnet before
   * signing. Re-checks the testnet gate, then switches the wallet's chain if it
   * is on a different one — so the tx never lands on the wrong (or a mainnet) chain.
   */
  const prepareWallet = useCallback(async (): Promise<WalletClient> => {
    if (!isAdminTestnetChain(chainId)) {
      throw new Error('This page only operates on testnets — pick an allowed testnet.')
    }
    if (!primaryWallet) throw new Error('Connect a wallet first.')
    const walletClient = await getWalletClient(primaryWallet)
    if (walletClient.chain?.id !== chainId) {
      // Align the wallet to the selected chain (prompts the wallet's switch UI).
      await walletClient.switchChain({ id: chainId })
    }
    return walletClient
  }, [chainId, primaryWallet])

  // ── Action 1: deploy the registry ──────────────────────────────────────────
  async function handleDeploy(): Promise<void> {
    setDeployState({ phase: 'pending' })
    try {
      const walletClient = await prepareWallet()
      const publicClient = getAdminPublicClient(chainId)
      const { txHash, address } = await deployRegistry(walletClient, publicClient)
      setRegistry(address)
      setRegistryInput(address)
      setDeployState({ phase: 'done', txHash })
    } catch (err) {
      setDeployState({ phase: 'error', error: humanizeAdminRevert(err) })
    }
  }

  // ── Action 2: claim the example repo ───────────────────────────────────────
  async function handleClaim(): Promise<void> {
    setClaimState({ phase: 'pending' })
    try {
      if (!effectiveRegistry) throw new Error('Set a registry address (deploy above, or paste one).')
      const walletClient = await prepareWallet()
      const publicClient = getAdminPublicClient(chainId)
      const { txHash } = await claimRepo(walletClient, publicClient, effectiveRegistry, repoId)
      setClaimState({ phase: 'done', txHash })
    } catch (err) {
      setClaimState({ phase: 'error', error: humanizeAdminRevert(err) })
    }
  }

  // ── Action 3: anchor an example release ────────────────────────────────────
  async function handleAnchor(): Promise<void> {
    setAnchorState({ phase: 'pending' })
    try {
      if (!effectiveRegistry) throw new Error('Set a registry address (deploy above, or paste one).')
      const validated = validateAnchorInput(cid, tag, merkleRoot)
      if (!validated.ok) {
        setAnchorState({ phase: 'error', error: validated.error })
        return
      }
      const walletClient = await prepareWallet()
      const publicClient = getAdminPublicClient(chainId)
      const { txHash } = await anchorRelease(
        walletClient,
        publicClient,
        effectiveRegistry,
        repoId,
        validated.value,
      )
      setAnchorState({ phase: 'done', txHash })
    } catch (err) {
      setAnchorState({ phase: 'error', error: humanizeAdminRevert(err) })
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10">
      {/* Header */}
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-display text-2xl font-semibold text-foreground">Owner admin</h1>
          <ConnectControl
            address={primaryWallet?.address ?? null}
            onConnect={() => setShowAuthFlow(true)}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Run every owner-gated, on-chain step from your own browser wallet — no keystore, no
          server. Each button is a transaction you sign yourself.
        </p>
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-accent">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          Testnet only
        </span>
      </header>

      {/* Chain picker + testnet gate */}
      <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Network</span>
          <select
            value={chainId}
            onChange={(e) => setChainId(Number(e.target.value))}
            className="rounded-md border border-input bg-background px-3 py-2 text-foreground outline-none focus:border-primary"
          >
            {ADMIN_TESTNET_CHAINS.map(({ chain, label }) => (
              <option key={chain.id} value={chain.id}>
                {label} ({chain.id})
              </option>
            ))}
          </select>
        </label>
        {onTestnet ? null : (
          <p className="text-sm text-destructive">
            Mainnet is not allowed here. Pick one of the testnets above.
          </p>
        )}
      </section>

      {/* Registry address (deploy result, or manual paste) */}
      <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">
            Registry address{' '}
            <span className="text-muted-foreground">
              (filled by a deploy below, or paste an existing one)
            </span>
          </span>
          <input
            type="text"
            value={registryInput}
            onChange={(e) => {
              setRegistryInput(e.target.value)
              // A manual edit clears the deploy-pinned value so the paste wins.
              setRegistry('')
            }}
            placeholder="0x… ProvenanceRegistry address"
            spellCheck={false}
            className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
          />
        </label>
        {registryInput.trim() && !effectiveRegistry ? (
          <p className="text-xs text-destructive">That is not a valid 0x address.</p>
        ) : effectiveRegistry ? (
          <p className="text-xs text-success">
            Using {short(effectiveRegistry)}
            {explorer ? (
              <>
                {' · '}
                <a
                  href={adminAddressUrl(chainId, effectiveRegistry) ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  view on explorer
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      {/* Step 1 — Deploy */}
      <ActionCard
        step={1}
        title="Deploy Access0x1ProvenanceRegistry"
        description="Deploys a fresh registry from your wallet. The deployed address is saved above for the next steps."
      >
        <button
          type="button"
          onClick={() => void handleDeploy()}
          disabled={!primaryWallet || !onTestnet || deployState.phase === 'pending'}
          className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deployState.phase === 'pending' ? 'Deploying…' : 'Deploy registry'}
        </button>
        <ActionStatus chainId={chainId} state={deployState} pendingLabel="Waiting for the deploy to mine…" />
      </ActionCard>

      {/* Step 2 — Claim the example repo */}
      <ActionCard
        step={2}
        title="Claim the example repo"
        description="Calls claimRepo(repoId) so this wallet owns the example repo's provenance. First-claim-wins."
      >
        <dl className="flex flex-col gap-1 text-xs text-muted-foreground">
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">Repo string</dt>
            <dd className="break-all font-mono">{EXAMPLE_REPO_STRING}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">repoId (keccak256)</dt>
            <dd className="break-all font-mono">{repoId}</dd>
          </div>
        </dl>
        <button
          type="button"
          onClick={() => void handleClaim()}
          disabled={
            !primaryWallet || !onTestnet || !effectiveRegistry || claimState.phase === 'pending'
          }
          className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {claimState.phase === 'pending' ? 'Claiming…' : 'Claim repo'}
        </button>
        <ActionStatus chainId={chainId} state={claimState} pendingLabel="Waiting for the claim to mine…" />
      </ActionCard>

      {/* Step 3 — Anchor a release */}
      <ActionCard
        step={3}
        title="Anchor an example release"
        description="Calls anchorRelease(repoId, cid, tag, merkleRoot) under the claimed repo."
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Content id (CID)</span>
          <input
            type="text"
            value={cid}
            onChange={(e) => setCid(e.target.value)}
            placeholder="bafy… (IPFS CID)"
            spellCheck={false}
            className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">
            Tag <span className="text-muted-foreground">(optional)</span>
          </span>
          <input
            type="text"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="v1.0.0"
            spellCheck={false}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Merkle root (bytes32)</span>
          <input
            type="text"
            value={merkleRoot}
            onChange={(e) => setMerkleRoot(e.target.value)}
            placeholder="0x… (0x + 64 hex chars)"
            spellCheck={false}
            className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
          />
        </label>
        <button
          type="button"
          onClick={() => void handleAnchor()}
          disabled={
            !primaryWallet || !onTestnet || !effectiveRegistry || anchorState.phase === 'pending'
          }
          className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {anchorState.phase === 'pending' ? 'Anchoring…' : 'Anchor release'}
        </button>
        <ActionStatus chainId={chainId} state={anchorState} pendingLabel="Waiting for the anchor to mine…" />
      </ActionCard>

      {!primaryWallet ? (
        <p className="text-center text-sm text-muted-foreground">
          Connect a wallet to enable the buttons above.
        </p>
      ) : null}
    </main>
  )
}

/** The connect / connected-address control in the header. */
function ConnectControl({
  address,
  onConnect,
}: {
  address: string | null
  onConnect: () => void
}): ReactNode {
  if (address) {
    return (
      <span className="rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground">
        {short(address)}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onConnect}
      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
    >
      Connect wallet
    </button>
  )
}

/** A numbered action card wrapping one on-chain step's controls. */
function ActionCard({
  step,
  title,
  description,
  children,
}: {
  step: number
  title: string
  description: string
  children: ReactNode
}): ReactNode {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {step}
        </span>
        <div className="flex flex-col gap-0.5">
          <h2 className="font-medium text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

/** Render the pending / success (tx hash + explorer link) / error state of an action. */
function ActionStatus({
  chainId,
  state,
  pendingLabel,
}: {
  chainId: number
  state: ActionState
  pendingLabel: string
}): ReactNode {
  if (state.phase === 'pending') {
    return <p className="text-sm text-muted-foreground">{pendingLabel}</p>
  }
  if (state.phase === 'error' && state.error) {
    return <p className="text-sm text-destructive">{state.error}</p>
  }
  if (state.phase === 'done' && state.txHash) {
    const url = adminTxUrl(chainId, state.txHash)
    return (
      <p className="text-sm text-success">
        Done ·{' '}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-primary underline-offset-2 hover:underline"
          >
            {short(state.txHash)}
          </a>
        ) : (
          <span className="font-mono">{state.txHash}</span>
        )}
      </p>
    )
  }
  return null
}
