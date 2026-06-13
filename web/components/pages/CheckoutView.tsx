'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { getDefaultChainId, getRouterAddress } from '@/lib/chains'
import { getMerchant, type Merchant } from '@/lib/contracts'
import { getPublicClient } from '@/lib/wallet'
import { CheckoutCard } from '@/components/CheckoutCard'
import { AskAssistant } from '@/components/AskAssistant'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Hosted checkout view for `/m/[merchantId]`.
 *
 * Reads the merchant record from the router, then renders the white-label
 * CheckoutCard (which fetches the live USDC quote and pays). URL params:
 *   ?amount=29.00      override the price
 *   ?order=<id>        sets the orderId
 *   ?return_url=<url>  back link shown after success
 *
 * The readable name comes from the URL (?name=) or localStorage (set at
 * onboard) — the on-chain record only stores the nameHash commitment, so until
 * a brand sidecar exists the display name is supplied client-side.
 *
 * Rendered client-only (route wrapper imports with ssr: false).
 */
export function CheckoutView({ merchantIdParam }: { merchantIdParam: string }): ReactNode {
  const searchParams = useSearchParams()
  const chainId = getDefaultChainId()

  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  let merchantId: bigint | null = null
  try {
    merchantId = BigInt(merchantIdParam)
  } catch {
    merchantId = null
  }

  useEffect(() => {
    if (merchantId === null) {
      setLoadError('Invalid merchant id.')
      setLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const routerAddress = getRouterAddress(chainId)
        const client = getPublicClient(chainId)
        const m = await getMerchant(client, routerAddress, merchantId)
        if (cancelled) return
        if (m.owner === ZERO_ADDRESS) {
          setLoadError('Access0x1__MerchantNotFound')
        } else {
          setMerchant(m)
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load merchant.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chainId, merchantId])

  const amount = searchParams.get('amount') ?? '29.00'
  const orderParam = searchParams.get('order') ?? undefined
  const returnUrl = searchParams.get('return_url') ?? undefined
  const nameParam = searchParams.get('name') ?? undefined

  const merchantName =
    nameParam ??
    (typeof window !== 'undefined' ? localStorage.getItem('ax1_merchant_name') : null) ??
    `Merchant #${merchantIdParam}`

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
      {loading ? (
        <div className="h-64 animate-pulse rounded-2xl bg-neutral-100" />
      ) : loadError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {loadError === 'Access0x1__MerchantNotFound'
            ? 'This payment link is not valid.'
            : loadError}
        </div>
      ) : merchant && merchantId !== null ? (
        <section className="rounded-2xl border border-neutral-200 p-6">
          <CheckoutCard
            chainId={chainId}
            merchantId={merchantId}
            merchant={merchant}
            merchantName={merchantName}
            usdAmount={amount}
            orderParam={orderParam}
            returnUrl={returnUrl}
          />
        </section>
      ) : null}

      <AskAssistant />
    </main>
  )
}
