'use client'

/**
 * OwnYourName — buy a real .eth name from inside the app, offered ONLY when the
 * connected wallet has no primary name yet.
 *
 * This component renders the step engine (lib/ens/ownName.ts) and never invents
 * its own ordering: the engine decides the step, the component shows it. All
 * protocol correctness lives in the tested engine + registrar client —
 * commit → mandatory wait → register — including the rules that block a doomed
 * transaction (early register, expired commitment, switched wallet).
 *
 * Wallet pattern mirrors CheckoutCard: wagmi `useAccount`/`useWalletClient` for
 * the buyer's viem WalletClient (both txs are signed by the BUYER — zero
 * custody, no server route), a viem public client for reads, and
 * `walletClient.switchChain` when the wallet sits on the wrong chain (the
 * registrar chain is Sepolia by default — testnet-only law).
 *
 * Fail-soft (law 1): with no NEXT_PUBLIC_ENS_REGISTRAR_CONTROLLER configured
 * the component renders NOTHING — the free subname claim remains the default
 * onboarding path and no dead UI ships.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { formatEther, type Hex } from 'viem'

import {
  buildCommitTx,
  buildRegisterTx,
  checkAvailable,
  clampDuration,
  commitmentWindow,
  DEFAULT_REGISTRATION_SECONDS,
  makeCommitment,
  quoteRent,
  randomSecret,
  registrarClient,
  registrarConfig,
  validateLabel,
  type RegistrationParams,
  type RentQuote,
} from '@/lib/ens/registrar'
import {
  canRegisterFrom,
  clearPending,
  currentStep,
  loadPending,
  savePending,
  secondsUntilOpen,
  type PendingCommitment,
} from '@/lib/ens/ownName'
import { usePrimaryEnsName } from '@/lib/ens/usePrimaryEnsName'

/** Honest, non-technical copy for the usual wallet failures. Never a stack trace. */
function humanizeTxError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/user rejected|denied|rejected the request/i.test(msg)) return 'You cancelled in the wallet — nothing was sent.'
  if (/insufficient funds/i.test(msg)) return 'Not enough Sepolia ETH for this transaction. Top up from a faucet and retry.'
  if (/CommitmentTooNew/i.test(msg)) return 'The 60-second window has not fully elapsed on-chain yet — wait a moment and retry.'
  if (/CommitmentTooOld|CommitmentNotFound/i.test(msg)) return 'The commitment expired or was not found — start again with a fresh commit.'
  if (/InsufficientValue/i.test(msg)) return 'The price moved above the sent value — refresh the quote and retry.'
  const line = msg.split('\n')[0] ?? 'Transaction failed.'
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

const LABEL_PROBLEM_COPY = {
  empty: 'Type the name you want (without .eth).',
  contains_dot: 'Just the name itself — no dots. Subnames are claimed on the free path.',
  too_short: '.eth names need at least 3 characters (1–2 character names are reserved by ENS).',
  not_normalizable: 'That name contains characters ENS does not allow.',
} as const

/** localStorage behind the engine's injected-store seam (memory stub in tests). */
const browserStore = () => (typeof window === 'undefined' ? null : window.localStorage)

export default function OwnYourName(): React.ReactNode {
  const cfg = useMemo(() => registrarConfig(), [])
  const { address, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { name: primaryName, loading: nameLoading } = usePrimaryEnsName(address)

  const [input, setInput] = useState('')
  const [checking, setChecking] = useState(false)
  const [quote, setQuote] = useState<{ label: string; rent: RentQuote } | null>(null)
  const [notAvailable, setNotAvailable] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingCommitment | null>(null)
  const [txInFlight, setTxInFlight] = useState<'commit' | 'register' | undefined>()
  const [registered, setRegistered] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  // Rehydrate a pending commitment (a refresh must never strand a paid commit tx).
  useEffect(() => {
    const store = browserStore()
    if (!store || !cfg || !address) return
    setPending(loadPending(store, cfg.chainId, address, Date.now()))
  }, [cfg, address])

  // 1s tick drives the countdown + the waiting→ready transition.
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pending])

  const step = currentStep({
    hasPrimaryName: !!primaryName,
    pending,
    nowMs,
    txInFlight,
    registered: registered !== null,
  })

  const publicClient = useMemo(() => (cfg ? registrarClient(cfg) : null), [cfg])

  const doCheck = useCallback(async () => {
    if (!cfg || !publicClient) return
    setError(null)
    setQuote(null)
    setNotAvailable(null)
    const valid = validateLabel(input)
    if (!valid.ok) {
      setError(LABEL_PROBLEM_COPY[valid.problem])
      return
    }
    setChecking(true)
    try {
      const available = await checkAvailable(publicClient, cfg, valid.label)
      if (!available) {
        setNotAvailable(valid.label)
        return
      }
      const rent = await quoteRent(publicClient, cfg, valid.label, clampDuration(DEFAULT_REGISTRATION_SECONDS))
      setQuote({ label: valid.label, rent })
    } catch (err) {
      setError(humanizeTxError(err))
    } finally {
      setChecking(false)
    }
  }, [cfg, publicClient, input])

  const doCommit = useCallback(async () => {
    if (!cfg || !publicClient || !walletClient || !address || !quote) return
    setError(null)
    setTxInFlight('commit')
    try {
      if (walletClient.chain?.id !== cfg.chainId) {
        await walletClient.switchChain({ id: cfg.chainId })
      }
      const params: RegistrationParams = {
        label: quote.label,
        owner: address,
        durationSeconds: clampDuration(DEFAULT_REGISTRATION_SECONDS),
        secret: randomSecret(),
        resolver: cfg.resolver,
        data: [],
        // Set the primary name in the same tx when a resolver is configured —
        // that is the whole point of "own your name". Bare register otherwise.
        reverseRecord: cfg.resolver !== '0x0000000000000000000000000000000000000000',
      }
      const commitment = await makeCommitment(publicClient, cfg, params)
      const hash = await walletClient.writeContract({
        ...buildCommitTx(cfg, commitment),
        account: address,
        chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      const block = await publicClient.getBlock({ blockHash: receipt.blockHash })
      const window = await commitmentWindow(publicClient, cfg)
      const p: PendingCommitment = {
        label: params.label,
        owner: address,
        durationSeconds: params.durationSeconds.toString(),
        secret: params.secret,
        resolver: params.resolver,
        data: params.data as Hex[],
        reverseRecord: params.reverseRecord,
        commitment,
        chainId: cfg.chainId,
        controller: cfg.controller,
        committedAtMs: Number(block.timestamp) * 1000,
        minAgeS: window.minAgeS,
        maxAgeS: window.maxAgeS,
      }
      const store = browserStore()
      if (store) savePending(store, p)
      setPending(p)
      setNowMs(Date.now())
    } catch (err) {
      setError(humanizeTxError(err))
    } finally {
      setTxInFlight(undefined)
    }
  }, [cfg, publicClient, walletClient, address, quote])

  const doRegister = useCallback(async () => {
    if (!cfg || !publicClient || !walletClient || !address || !pending) return
    setError(null)
    // The engine's guards, enforced before any wallet popup:
    if (!canRegisterFrom(pending, address)) {
      setError(`This name was committed from ${pending.owner}. Switch back to that wallet to finish.`)
      return
    }
    setTxInFlight('register')
    try {
      if (walletClient.chain?.id !== cfg.chainId) {
        await walletClient.switchChain({ id: cfg.chainId })
      }
      // Re-quote at register time: the USD price is oracle-converted to ETH and
      // the commit-time quote can be minutes old. Value carries the 5% buffer;
      // the controller refunds every wei above the true price.
      const rent = await quoteRent(publicClient, cfg, pending.label, BigInt(pending.durationSeconds))
      const params: RegistrationParams = {
        label: pending.label,
        owner: pending.owner,
        durationSeconds: BigInt(pending.durationSeconds),
        secret: pending.secret,
        resolver: pending.resolver,
        data: pending.data,
        reverseRecord: pending.reverseRecord,
      }
      const hash = await walletClient.writeContract({
        ...buildRegisterTx(cfg, params, rent.valueWei),
        account: address,
        chain: walletClient.chain,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      const store = browserStore()
      if (store) clearPending(store, cfg.chainId, address)
      setPending(null)
      setRegistered(`${pending.label}.eth`)
    } catch (err) {
      setError(humanizeTxError(err))
    } finally {
      setTxInFlight(undefined)
    }
  }, [cfg, publicClient, walletClient, address, pending])

  const abandonExpired = useCallback(() => {
    const store = browserStore()
    if (store && cfg && address) clearPending(store, cfg.chainId, address)
    setPending(null)
    setQuote(null)
    setError(null)
  }, [cfg, address])

  // Fail-soft: unconfigured ⇒ render nothing (the free subname path is unaffected).
  if (!cfg) return null

  if (!isConnected || !address) {
    return (
      <section className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold text-ink">Own your name</h3>
        <p className="mt-1 text-sm opacity-80">Connect a wallet to check and register your own .eth name.</p>
      </section>
    )
  }

  if (nameLoading) {
    return (
      <section className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold text-ink">Own your name</h3>
        <p className="mt-1 text-sm opacity-80">Checking whether this wallet already has a name…</p>
      </section>
    )
  }

  if (step === 'already_named') {
    return (
      <section className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold text-ink">Own your name</h3>
        <p className="mt-1 text-sm">
          This wallet already answers to <span className="font-semibold">{primaryName}</span> ✓ — nothing to buy.
        </p>
      </section>
    )
  }

  if (step === 'done' && registered) {
    return (
      <section className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold text-ink">Own your name</h3>
        <p className="mt-1 text-sm">
          <span className="font-semibold">{registered}</span> is yours — registered on-chain from your own wallet.
        </p>
        <p className="mt-1 text-xs opacity-70">
          Registered on the app&apos;s test network. Records{pending?.reverseRecord ? ' and your primary name were' : ' were'} set in the
          same transaction where configured.
        </p>
      </section>
    )
  }

  const waitSeconds = pending ? secondsUntilOpen(pending, nowMs) : 0

  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-sm font-semibold text-ink">Own your name</h3>
      <p className="mt-1 text-xs opacity-70">
        A real .eth name, bought from your connected wallet in two transactions with ENS&apos;s mandatory
        60-second wait between them. Prefer free? Claim a <code>pay.&lt;business&gt;</code> subname instead.
      </p>

      {(step === 'pick' || step === 'quoted') && (
        <div className="mt-3">
          <div className="flex gap-2">
            <input
              className="w-full rounded border px-2 py-1 text-sm"
              placeholder="yourname"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void doCheck()}
              aria-label="The .eth name to check"
            />
            <span className="self-center text-sm opacity-70">.eth</span>
            <button
              type="button"
              className="rounded border px-3 py-1 text-sm font-semibold"
              onClick={() => void doCheck()}
              disabled={checking}
            >
              {checking ? 'Checking…' : 'Check'}
            </button>
          </div>
          {notAvailable && (
            <p className="mt-2 text-sm">
              <span className="font-semibold">{notAvailable}.eth</span> is taken — try another.
            </p>
          )}
          {quote && (
            <div className="mt-3 rounded border p-3">
              <p className="text-sm">
                <span className="font-semibold">{quote.label}.eth</span> is available —{' '}
                {formatEther(quote.rent.totalWei)} ETH / year
                {quote.rent.premiumWei > 0n ? ' (includes a temporary just-expired premium)' : ''}.
              </p>
              <p className="mt-1 text-xs opacity-70">
                Step 1 of 2: commit. Your wallet signs a small transaction that reserves your claim
                without revealing the name. The price is charged at step 2; anything sent above the
                final price is refunded by ENS.
              </p>
              <button
                type="button"
                className="mt-2 rounded border px-3 py-1 text-sm font-semibold"
                onClick={() => void doCommit()}
                disabled={!walletClient || txInFlight !== undefined}
              >
                Commit — start the 60s clock
              </button>
            </div>
          )}
        </div>
      )}

      {step === 'committing' && <p className="mt-3 text-sm">Confirm the commit in your wallet… then it mines.</p>}

      {step === 'waiting' && pending && (
        <div className="mt-3 rounded border p-3">
          <p className="text-sm">
            <span className="font-semibold">{pending.label}.eth</span> committed. Register opens in{' '}
            <span className="font-mono font-semibold">{waitSeconds}s</span>.
          </p>
          <p className="mt-1 text-xs opacity-70">
            This wait is ENS&apos;s anti-frontrunning rule, enforced on-chain — every registrar has it. Your
            claim is safe; you can even refresh this page.
          </p>
        </div>
      )}

      {step === 'ready_to_register' && pending && (
        <div className="mt-3 rounded border p-3">
          <p className="text-sm">
            <span className="font-semibold">{pending.label}.eth</span> is ready to register.
          </p>
          <button
            type="button"
            className="mt-2 rounded border px-3 py-1 text-sm font-semibold"
            onClick={() => void doRegister()}
            disabled={!walletClient || txInFlight !== undefined}
          >
            Register {pending.label}.eth — step 2 of 2
          </button>
        </div>
      )}

      {step === 'registering' && <p className="mt-3 text-sm">Confirm the registration in your wallet… then it mines.</p>}

      {step === 'expired' && (
        <div className="mt-3 rounded border p-3">
          <p className="text-sm">That commitment expired (ENS gives 24 hours). No name was lost — start fresh.</p>
          <button type="button" className="mt-2 rounded border px-3 py-1 text-sm font-semibold" onClick={abandonExpired}>
            Start again
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
