'use client'

import type { ReactNode } from 'react'
import type { Hash } from 'viem'
import type { PaymentReceivedEvent } from '@/lib/contracts'
import { amount8ToUsd, formatTokenAmount } from '@/lib/quote'
import { safeReturnUrl } from '@/lib/safeUrl'
import { TxHashLink } from './TxHashLink'

/**
 * Success view after a settled payment. Shows the amount paid (in token
 * decimals), the USD equivalent (exactly `usdAmount8` from the event — law #4),
 * the txHash, and the orderId. "Return to merchant" appears only if a
 * `returnUrl` was passed in the checkout URL.
 */
export function ReceiptScreen({
  receipt,
  txHash,
  chainId,
  tokenSymbol,
  tokenDecimals,
  returnUrl,
}: {
  receipt: PaymentReceivedEvent
  txHash: Hash
  chainId: number
  tokenSymbol: string
  tokenDecimals: number
  returnUrl?: string
}): ReactNode {
  // Defense-in-depth: re-validate at the render boundary so a tainted href can
  // never reach this payment-confirmed page, regardless of the caller (C-1). Only
  // an https: URL renders the link; anything else drops it entirely.
  const safeReturn = safeReturnUrl(returnUrl)
  return (
    // `role="status"` + `aria-live="polite"` announces the settled payment to a
    // screen reader when this view swaps in after `handlePay` resolves — the
    // buyer hears "Payment confirmed", not silence.
    <div className="flex flex-col gap-4 text-center" role="status" aria-live="polite">
      {/* The check is decorative: the heading below carries the meaning, so hide
          the bare "✓" from assistive tech (it would otherwise read as a stray
          "check mark"). Matches the aria-hidden glyph convention used across the
          app (CasinoVerifiedBadge, FeatureGrid, the gas-sponsored badge). */}
      <div
        aria-hidden="true"
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl text-green-700"
      >
        ✓
      </div>
      <h2 className="text-xl font-semibold text-ink">Payment confirmed</h2>

      <div className="flex flex-col gap-1">
        <p className="text-3xl font-semibold text-ink">
          {formatTokenAmount(receipt.grossAmount, tokenDecimals)} {tokenSymbol}
        </p>
        <p className="text-sm text-neutral-500">${amount8ToUsd(receipt.usdAmount8)} USD</p>
      </div>

      <dl className="mx-auto w-full max-w-sm text-left text-sm">
        <div className="flex justify-between border-t border-neutral-100 py-2">
          <dt className="text-neutral-500">Transaction</dt>
          <dd className="truncate pl-4">
            <TxHashLink chainId={chainId} hash={txHash} full className="font-mono text-rail underline-offset-2 hover:underline" />
          </dd>
        </div>
        <div className="flex justify-between border-t border-neutral-100 py-2">
          <dt className="text-neutral-500">Order</dt>
          <dd className="truncate pl-4 font-mono">{receipt.orderId}</dd>
        </div>
      </dl>

      {safeReturn ? (
        <a
          href={safeReturn}
          rel="noopener noreferrer"
          className="mx-auto mt-2 rounded-lg bg-rail px-5 py-2.5 font-medium text-white hover:opacity-90"
        >
          Return to merchant
        </a>
      ) : null}
    </div>
  )
}
