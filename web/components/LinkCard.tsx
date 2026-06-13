'use client'

import { useEffect, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'
import type { RegisterResult } from './RegisterForm'
import { TxHashLink } from './TxHashLink'

/** A copy-to-clipboard button that shows transient "Copied" feedback. */
function CopyButton({ value }: { value: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/**
 * After a successful register, show the three-panel result: the hosted link,
 * the one-line embed snippet, and a downloadable QR. Also surfaces the txHash
 * and merchantId. The QR encodes the same hosted link.
 */
export function LinkCard({ result }: { result: RegisterResult }): ReactNode {
  const [origin, setOrigin] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')

  useEffect(() => {
    // window is only available on the client; the host is the deploy origin.
    setOrigin(window.location.origin)
  }, [])

  const link = origin ? `${origin}/m/${result.merchantId.toString()}` : ''
  const snippet = origin
    ? `<script src="${origin}/embed.js" data-merchant="${result.merchantId.toString()}" data-amount-usd="${result.priceUsd}"></script>`
    : ''

  useEffect(() => {
    if (!link) return
    void QRCode.toDataURL(link, { width: 240, margin: 1 }).then(setQrDataUrl)
  }, [link])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">{result.name} is live</h2>
        <p className="text-sm text-neutral-500">
          Merchant #{result.merchantId.toString()} · ${result.priceUsd} · chain {result.chainId}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-ink">Payment link</span>
        <div className="flex items-center gap-2">
          <code className="grow truncate rounded-lg bg-neutral-100 px-3 py-2 text-sm">{link}</code>
          <CopyButton value={link} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-ink">Embed snippet</span>
        <div className="flex items-start gap-2">
          <code className="grow whitespace-pre-wrap break-all rounded-lg bg-neutral-100 px-3 py-2 text-xs">
            {snippet}
          </code>
          <CopyButton value={snippet} />
        </div>
      </div>

      <div className="flex flex-col items-start gap-2">
        <span className="text-sm font-medium text-ink">QR code</span>
        {qrDataUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrDataUrl} alt={`QR code for ${result.name} checkout`} width={240} height={240} />
            <a
              href={qrDataUrl}
              download={`access0x1-merchant-${result.merchantId.toString()}.png`}
              className="text-sm text-rail underline-offset-2 hover:underline"
            >
              Download QR
            </a>
          </>
        ) : (
          <div className="h-[240px] w-[240px] animate-pulse rounded-lg bg-neutral-100" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <a
          href={link || '#'}
          className="rounded-lg bg-rail px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Try the checkout
        </a>
        <a
          href="/dashboard"
          className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-ink hover:bg-neutral-50"
        >
          View dashboard
        </a>
      </div>

      <p className="text-xs text-neutral-400">
        tx <TxHashLink chainId={result.chainId} hash={result.txHash} className="font-mono text-neutral-500 underline-offset-2 hover:underline" />
      </p>
    </div>
  )
}
