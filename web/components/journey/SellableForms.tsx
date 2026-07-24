'use client'

import { useState, type FormEvent, type ReactNode } from 'react'
import { isAddress, type Address, type Hash, type PublicClient, type WalletClient } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { ensureChain, useLiveChain } from '@/lib/live-chain'
import { getPublicClient, getWalletClient } from '@/lib/wallet'
import { usdToAmount8 } from '@/lib/quote'
import { createInvoice, issueGiftCard, setSubscriptionPlan } from '@/lib/journey/sellables'
import { TxHashLink } from '@/components/TxHashLink'

/**
 * SellableForms — the three "create something a business sells" steps of the
 * journey wizard, each a thin form over the typed lib/journey/sellables
 * helpers, all riding one shared submit path ({@link useSellableWrite}) that
 * enforces the RegisterForm chain discipline: the write lands only on the
 * wallet's LIVE chain, pinned with ensureChain before signing — the module
 * resolved and the chain signed can never diverge.
 *
 * Every success line carries the REAL parsed id + tx hash from the receipt
 * (the sellables helpers refuse to invent one), and every revert surfaces its
 * message honestly — the chain is the authority on merchant ownership.
 */

/** One shared submit engine: live-chain guard + wallet pin + honest errors. */
function useSellableWrite(): {
  submitting: boolean
  error: string | null
  chainId: number | null
  isSupported: boolean
  run: <T>(
    fn: (wallet: WalletClient, publicClient: PublicClient, chainId: number) => Promise<T>,
  ) => Promise<T | null>
} {
  const { primaryWallet } = useDynamicContext()
  const live = useLiveChain()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run<T>(
    fn: (wallet: WalletClient, publicClient: PublicClient, chainId: number) => Promise<T>,
  ): Promise<T | null> {
    setError(null)
    if (!primaryWallet) {
      setError('Connect a wallet first.')
      return null
    }
    if (live.chainId === null || !live.isSupported) {
      setError('Your wallet is on a network this rail can’t write on — switch network above.')
      return null
    }
    const chainId = live.chainId
    setSubmitting(true)
    try {
      let walletClient = await getWalletClient(primaryWallet)
      // Pin the wallet to the live chain BEFORE the write; re-derive after a
      // switch so the client's chain snapshot matches (the RegisterForm law).
      const switched = await ensureChain(walletClient, chainId)
      if (switched) walletClient = await getWalletClient(primaryWallet)
      return await fn(walletClient, getPublicClient(chainId), chainId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed.')
      return null
    } finally {
      setSubmitting(false)
    }
  }

  return { submitting, error, chainId: live.chainId, isSupported: live.isSupported, run }
}

const inputCls =
  'rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-rail'
const buttonCls =
  'rounded-lg bg-rail px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'

/** Billing periods a business actually picks from, in seconds. */
export const PLAN_PERIODS = [
  { label: 'Weekly', secs: 7 * 24 * 3600 },
  { label: 'Monthly', secs: 30 * 24 * 3600 },
  { label: 'Yearly', secs: 365 * 24 * 3600 },
] as const

/** Step 3 — price a product: publish a subscription plan. */
export function PlanForm({
  merchantId,
  onCreated,
}: {
  merchantId: bigint
  onCreated: (result: { planKey: number; txHash: Hash; chainId: number }) => void
}): ReactNode {
  const { submitting, error, run } = useSellableWrite()
  const [priceUsd, setPriceUsd] = useState('9.99')
  const [planKey, setPlanKey] = useState('1')
  const [periodSecs, setPeriodSecs] = useState(String(PLAN_PERIODS[1].secs))
  const [formError, setFormError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setFormError(null)
    const price = Number(priceUsd)
    if (!Number.isFinite(price) || price <= 0) {
      setFormError('Enter a valid USD price greater than 0.')
      return
    }
    const key = Number(planKey)
    if (!Number.isInteger(key) || key < 0 || key > 255) {
      setFormError('Plan number must be 0–255.')
      return
    }
    const res = await run((wallet, publicClient, chainId) =>
      setSubscriptionPlan(wallet, publicClient, chainId, {
        merchantId,
        planKey: key,
        priceUsd8: usdToAmount8(price),
        periodSecs: Number(periodSecs),
      }).then((r) => ({ ...r, chainId })),
    )
    if (res) onCreated(res)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" data-testid="plan-form">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Price (USD)</span>
          <input type="number" id="sellable-price" name="price" autoComplete="off" min="0.01" step="0.01" value={priceUsd} onChange={(e) => setPriceUsd(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Billing period</span>
          <select id="sellable-period" name="period" autoComplete="off" value={periodSecs} onChange={(e) => setPeriodSecs(e.target.value)} className={inputCls}>
            {PLAN_PERIODS.map((p) => (
              <option key={p.secs} value={p.secs}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Plan number</span>
          <input type="number" id="sellable-plan-key" name="planKey" autoComplete="off" min="0" max="255" value={planKey} onChange={(e) => setPlanKey(e.target.value)} className={inputCls} />
        </label>
      </div>
      {formError ?? error ? <p className="text-sm text-red-600">{formError ?? error}</p> : null}
      <button type="submit" disabled={submitting} className={buttonCls}>
        {submitting ? 'Publishing plan…' : 'Publish the plan on-chain'}
      </button>
    </form>
  )
}

/** Step 4 — bill a customer: create an on-chain invoice (native-coin priced). */
export function InvoiceForm({
  merchantId,
  onCreated,
}: {
  merchantId: bigint
  onCreated: (result: { invoiceId: bigint; txHash: Hash; chainId: number }) => void
}): ReactNode {
  const { submitting, error, run } = useSellableWrite()
  const [amountUsd, setAmountUsd] = useState('125.00')
  const [memo, setMemo] = useState('Invoice #1')
  const [payer, setPayer] = useState('')
  const [dueDays, setDueDays] = useState('30')
  const [formError, setFormError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setFormError(null)
    const amount = Number(amountUsd)
    if (!Number.isFinite(amount) || amount <= 0) {
      setFormError('Enter a valid USD amount greater than 0.')
      return
    }
    const trimmedPayer = payer.trim()
    if (trimmedPayer && !isAddress(trimmedPayer)) {
      setFormError('Payer must be a 0x address (or leave it empty so anyone can pay).')
      return
    }
    const days = Number(dueDays)
    if (!Number.isInteger(days) || days <= 0) {
      setFormError('Due in (days) must be a positive whole number.')
      return
    }
    const dueBy = BigInt(Math.floor(Date.now() / 1000) + days * 24 * 3600)
    const res = await run((wallet, publicClient, chainId) =>
      createInvoice(wallet, publicClient, chainId, {
        merchantId,
        payer: trimmedPayer ? (trimmedPayer as Address) : undefined,
        amountUsd8: usdToAmount8(amount),
        dueBy,
        memo,
      }).then((r) => ({ ...r, chainId })),
    )
    if (res) onCreated(res)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" data-testid="invoice-form">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Amount (USD)</span>
          <input type="number" id="sellable-amount" name="amount" autoComplete="off" min="0.01" step="0.01" value={amountUsd} onChange={(e) => setAmountUsd(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Due in (days)</span>
          <input type="number" id="sellable-due-days" name="dueDays" autoComplete="off" min="1" step="1" value={dueDays} onChange={(e) => setDueDays(e.target.value)} className={inputCls} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Memo <span className="text-muted-foreground">(only its hash goes on-chain)</span></span>
        <input type="text" id="sellable-memo" name="memo" autoComplete="off" value={memo} onChange={(e) => setMemo(e.target.value)} className={inputCls} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Payer <span className="text-muted-foreground">(optional — empty means anyone can pay)</span></span>
        <input type="text" id="sellable-payer" name="payer" autoComplete="off" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="0x…" className={`${inputCls} font-mono`} />
      </label>
      {formError ?? error ? <p className="text-sm text-red-600">{formError ?? error}</p> : null}
      <button type="submit" disabled={submitting} className={buttonCls}>
        {submitting ? 'Creating invoice…' : 'Create the invoice on-chain'}
      </button>
    </form>
  )
}

/** Step 5 — reward a customer: issue a USD-denominated gift card. */
export function GiftCardForm({
  merchantId,
  onCreated,
}: {
  merchantId: bigint
  onCreated: (result: { cardId: bigint; txHash: Hash; chainId: number }) => void
}): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const { submitting, error, run } = useSellableWrite()
  const [code, setCode] = useState('')
  const [faceUsd, setFaceUsd] = useState('25.00')
  const [recipient, setRecipient] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setFormError(null)
    if (code.trim().length < 4) {
      setFormError('Pick a card code of at least 4 characters — you’ll share it with the recipient.')
      return
    }
    const face = Number(faceUsd)
    if (!Number.isFinite(face) || face <= 0) {
      setFormError('Enter a valid USD value greater than 0.')
      return
    }
    const trimmedRecipient = recipient.trim()
    if (trimmedRecipient && !isAddress(trimmedRecipient)) {
      setFormError('Recipient must be a 0x address (or leave it empty to hold it yourself).')
      return
    }
    const self = primaryWallet?.address
    const to = (trimmedRecipient || self) as Address | undefined
    if (!to) {
      setFormError('Connect a wallet first.')
      return
    }
    const res = await run((wallet, publicClient, chainId) =>
      issueGiftCard(wallet, publicClient, chainId, {
        merchantId,
        code,
        recipient: to,
        faceUsd8: usdToAmount8(face),
      }).then((r) => ({ ...r, chainId })),
    )
    if (res) onCreated(res)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" data-testid="giftcard-form">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Card code <span className="text-muted-foreground">(never leaves your browser in the clear)</span></span>
          <input type="text" id="sellable-code" name="code" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="WELCOME25" className={`${inputCls} font-mono`} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Value (USD)</span>
          <input type="number" id="sellable-face-usd" name="faceUsd" autoComplete="off" min="0.01" step="0.01" value={faceUsd} onChange={(e) => setFaceUsd(e.target.value)} className={inputCls} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Recipient <span className="text-muted-foreground">(optional — defaults to you)</span></span>
        <input type="text" id="sellable-recipient" name="recipient" autoComplete="off" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" className={`${inputCls} font-mono`} />
      </label>
      {formError ?? error ? <p className="text-sm text-red-600">{formError ?? error}</p> : null}
      <button type="submit" disabled={submitting} className={buttonCls}>
        {submitting ? 'Issuing card…' : 'Issue the gift card on-chain'}
      </button>
    </form>
  )
}

/** A one-line receipt row shown under a completed create step. */
export function CreatedLine({
  label,
  txHash,
  chainId,
}: {
  label: string
  txHash: Hash
  chainId: number
}): ReactNode {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-green-700 dark:text-green-400" data-testid="created-line">
      <span>{label}</span>
      <TxHashLink hash={txHash} chainId={chainId} />
    </p>
  )
}
