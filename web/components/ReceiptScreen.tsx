'use client'

import type { ReactNode } from 'react'
import type { Hash } from 'viem'
import type { PaymentReceivedEvent } from '@/lib/contracts'
import { amount8ToUsd, formatTokenAmount } from '@/lib/quote'

/**
 * Success view after a settled payment. Shows the amount paid (in token
 * decimals), the USD equivalent (exactly `usdAmount8` from the event — law #4),
 * the txHash, and the orderId. "Return to merchant" appears only if a
 * `returnUrl` was passed in the checkout URL.
 */
export function ReceiptScreen({
  receipt,
  txHash,
  tokenSymbol,
  tokenDecimals,
  returnUrl,
}: {
  receipt: PaymentReceivedEvent
  txHash: Hash
  tokenSymbol: string
  tokenDecimals: number
  returnUrl?: string
}): ReactNode {
  return (
    <div className="flex flex-col gap-4 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl text-green-700">
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
          <dd className="truncate pl-4 font-mono">{txHash}</dd>
        </div>
        <div className="flex justify-between border-t border-neutral-100 py-2">
          <dt className="text-neutral-500">Order</dt>
          <dd className="truncate pl-4 font-mono">{receipt.orderId}</dd>
        </div>
      </dl>

      {returnUrl ? (
        <a
          href={returnUrl}
          className="mx-auto mt-2 rounded-lg bg-rail px-5 py-2.5 font-medium text-white hover:opacity-90"
        >
          Return to merchant
        </a>
      ) : null}
    </div>
  )
}
