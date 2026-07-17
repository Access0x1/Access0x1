'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { Hash } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { useLiveChain } from '@/lib/live-chain'
import {
  deriveJourney,
  journeyProgress,
  journeyStorageKey,
  parseJourneyRecord,
  EMPTY_RECORD,
  type JourneyRecord,
  type JourneyStep,
} from '@/lib/journey/steps'
import { NetworkBadge } from '@/components/NetworkBadge'
import { RegisterForm, type RegisterResult } from '@/components/RegisterForm'
import { CreatedLine, GiftCardForm, InvoiceForm, PlanForm } from '@/components/journey/SellableForms'
import { OnChainSvgSimulator } from '@/components/OnChainSvgSimulator'
import { Progress } from '@/components/ui/progress'

/**
 * JourneyView — /journey: the ordered business lifecycle, driven end-to-end
 * by the connected wallet. Every step below "connect" is a REAL on-chain
 * write signed by the business wallet (register → plan → invoice → gift card),
 * then the share link, then the simulated-only artwork step. The ordering is
 * the pure machine in lib/journey/steps — this container only feeds it facts:
 *
 *   - merchantId: the RegisterForm result, persisted under the SAME
 *     `ax1_merchant_id` key the dashboard reads (one browser, one truth);
 *   - created-things flags: per chain + merchant in localStorage, parsed
 *     defensively (junk degrades to not-done, never invented completion);
 *   - artwork: flipped by the simulator's first successful report.
 *
 * The ladder itself is the pure {@link JourneyLadder} (SSR-tested); step
 * bodies mount only while their step is `ready` — a locked step shows its
 * honest reason instead of a disabled form.
 */
export function JourneyView(): ReactNode {
  const { primaryWallet, setShowAuthFlow } = useDynamicContext()
  const live = useLiveChain()
  const [merchantId, setMerchantId] = useState<bigint | null>(null)
  const [record, setRecord] = useState<JourneyRecord>({ ...EMPTY_RECORD })
  const [receipts, setReceipts] = useState<Partial<Record<'plan' | 'invoice' | 'giftcard', { label: string; txHash: Hash; chainId: number }>>>({})

  // Restore the merchant seat this browser already registered (the dashboard's
  // cache key), then that merchant's per-chain journey record.
  useEffect(() => {
    try {
      const cached = localStorage.getItem('ax1_merchant_id')
      if (cached && /^\d+$/.test(cached)) setMerchantId(BigInt(cached))
    } catch {
      // Storage unavailable (private mode) — the journey just starts fresh.
    }
  }, [])
  useEffect(() => {
    if (merchantId === null || live.chainId === null) return
    try {
      setRecord(parseJourneyRecord(localStorage.getItem(journeyStorageKey(live.chainId, merchantId))))
    } catch {
      setRecord({ ...EMPTY_RECORD })
    }
  }, [merchantId, live.chainId])

  function saveRecord(next: JourneyRecord): void {
    setRecord(next)
    if (merchantId === null || live.chainId === null) return
    try {
      localStorage.setItem(journeyStorageKey(live.chainId, merchantId), JSON.stringify(next))
    } catch {
      // Best-effort cache — the receipts on-chain remain the real record.
    }
  }

  function handleRegistered(result: RegisterResult): void {
    setMerchantId(result.merchantId)
    try {
      localStorage.setItem('ax1_merchant_id', result.merchantId.toString())
    } catch {
      // Same best-effort contract as the dashboard's register path.
    }
  }

  const steps = deriveJourney({
    hasWallet: Boolean(primaryWallet),
    merchantId,
    planSet: record.planSet,
    invoiceCreated: record.invoiceCreated,
    giftCardIssued: record.giftCardIssued,
    artworkSimulated: record.artworkSimulated,
  })

  /** The interactive body for one step, mounted only while it is ready. */
  function bodyFor(step: JourneyStep): ReactNode {
    switch (step.key) {
      case 'connect':
        return (
          <button
            type="button"
            onClick={() => setShowAuthFlow(true)}
            className="rounded-lg bg-rail px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Connect wallet
          </button>
        )
      case 'register':
        return <RegisterForm onRegistered={handleRegistered} />
      case 'plan':
        return merchantId !== null ? (
          <PlanForm
            merchantId={merchantId}
            onCreated={(r) => {
              setReceipts((prev) => ({ ...prev, plan: { label: `Plan #${r.planKey} is live.`, txHash: r.txHash, chainId: r.chainId } }))
              saveRecord({ ...record, planSet: true })
            }}
          />
        ) : null
      case 'invoice':
        return merchantId !== null ? (
          <InvoiceForm
            merchantId={merchantId}
            onCreated={(r) => {
              setReceipts((prev) => ({ ...prev, invoice: { label: `Invoice #${r.invoiceId.toString()} is open.`, txHash: r.txHash, chainId: r.chainId } }))
              saveRecord({ ...record, invoiceCreated: true })
            }}
          />
        ) : null
      case 'giftcard':
        return merchantId !== null ? (
          <GiftCardForm
            merchantId={merchantId}
            onCreated={(r) => {
              setReceipts((prev) => ({ ...prev, giftcard: { label: 'Gift card issued.', txHash: r.txHash, chainId: r.chainId } }))
              saveRecord({ ...record, giftCardIssued: true })
            }}
          />
        ) : null
      case 'share':
        return merchantId !== null ? <ShareBody merchantId={merchantId} /> : null
      case 'artwork':
        return (
          <OnChainSvgSimulator
            onSimulated={() => {
              if (!record.artworkSimulated) saveRecord({ ...record, artworkSimulated: true })
            }}
          />
        )
    }
  }

  /** The done-state summary shown under a completed step. */
  function doneFor(step: JourneyStep): ReactNode {
    switch (step.key) {
      case 'register':
        return merchantId !== null ? (
          <p className="text-sm text-muted-foreground">
            Merchant seat <span className="font-mono text-ink">#{merchantId.toString()}</span> —
            manage it on the <Link href="/dashboard" className="text-rail hover:underline">dashboard</Link>.
          </p>
        ) : null
      case 'plan':
        return receipts.plan ? <CreatedLine {...receipts.plan} /> : null
      case 'invoice':
        return receipts.invoice ? <CreatedLine {...receipts.invoice} /> : null
      case 'giftcard':
        return receipts.giftcard ? <CreatedLine {...receipts.giftcard} /> : null
      case 'share':
        return merchantId !== null ? <ShareBody merchantId={merchantId} /> : null
      default:
        return null
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-ink">Run your business on-chain, in order</h1>
        <p className="text-sm text-muted-foreground">
          Seven steps, the order a real business operates. Every on-chain step is signed by YOUR
          wallet on the live network below — zero custody, testnets only.
        </p>
        <NetworkBadge />
      </header>
      <JourneyLadder
        steps={steps}
        progress={journeyProgress(steps)}
        renderBody={(step) => (step.status === 'ready' ? bodyFor(step) : doneFor(step))}
      />
      <p className="text-xs text-muted-foreground">
        Prefer free-form? Every module is also drivable directly from the{' '}
        <Link href="/contracts" className="text-rail hover:underline">rail console</Link>.
      </p>
    </main>
  )
}

/** The share-step body: the hosted checkout link + copy. */
function ShareBody({ merchantId }: { merchantId: bigint }): ReactNode {
  const [copied, setCopied] = useState(false)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const link = `${origin}/m/${merchantId.toString()}`
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="share-body">
      <code className="rounded-md bg-secondary px-2 py-1 font-mono text-xs text-ink">{link}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(link).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="rounded-md border border-input px-3 py-1 text-xs hover:bg-secondary"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <Link href={`/m/${merchantId.toString()}`} className="text-xs text-rail hover:underline">
        Open the checkout →
      </Link>
    </div>
  )
}

/**
 * Pure ordered ladder — no hooks, no wallet, fully SSR-testable. Each step is
 * tagged `data-journey-step` (key) + `data-journey-status` so tests assert the
 * ordering law straight off the HTML.
 */
export function JourneyLadder({
  steps,
  progress,
  renderBody,
}: {
  steps: readonly JourneyStep[]
  progress: number
  renderBody: (step: JourneyStep) => ReactNode
}): ReactNode {
  return (
    <section className="flex flex-col gap-4" data-journey-progress={progress}>
      <div className="flex items-center gap-3">
        <Progress value={progress} className="h-2" />
        <span className="shrink-0 text-xs font-medium text-muted-foreground">{progress}%</span>
      </div>
      <ol className="flex flex-col gap-3">
        {steps.map((step, i) => (
          <li
            key={step.key}
            data-journey-step={step.key}
            data-journey-status={step.status}
            className={`rounded-xl border p-4 ${
              step.status === 'ready'
                ? 'border-rail/50 bg-card'
                : step.status === 'done'
                  ? 'border-border bg-card'
                  : 'border-border/60 bg-background opacity-70'
            }`}
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  step.status === 'done'
                    ? 'bg-green-600 text-white'
                    : step.status === 'ready'
                      ? 'bg-rail text-white'
                      : 'bg-secondary text-muted-foreground'
                }`}
              >
                {step.status === 'done' ? '✓' : i + 1}
              </span>
              <div className="min-w-0">
                <p className="font-medium text-ink">{step.title}</p>
                <p className="text-xs text-muted-foreground">{step.blurb}</p>
              </div>
            </div>
            {step.status === 'locked' && step.lockedReason ? (
              <p className="mt-2 pl-10 text-xs text-amber-600" data-testid="locked-reason">
                {step.lockedReason}
              </p>
            ) : null}
            {step.status !== 'locked' ? <div className="mt-3 pl-10">{renderBody(step)}</div> : null}
          </li>
        ))}
      </ol>
    </section>
  )
}
