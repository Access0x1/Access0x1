'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { getDefaultChainId, getRouterAddress } from '@/lib/chains'
import { getMerchant, type Merchant } from '@/lib/contracts'
import { getPublicClient } from '@/lib/wallet'
import type { PublicBranding } from '@/lib/branding/response'
import { resolveGate } from '@/lib/worldid/gateConfig'
import { BrandMark } from '@/components/BrandMark'
import { CheckoutCard } from '@/components/CheckoutCard'
import { BrandPreview } from '@/components/branding/BrandPreview'
import { CasinoVerifiedBadge } from '@/components/CasinoVerifiedBadge'
import { isWorldIdConfigured } from '@/lib/worldid/config'
import { AskAssistant } from '@/components/AskAssistant'
import { safeReturnUrl } from '@/lib/safeUrl'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Branded hosted checkout for `pay.access0x1.com/c/{slug}` (ADR unit 5 / D4 a).
 *
 * Resolves the tenant by checkout slug via the PUBLIC branding endpoint, renders
 * the white-label header — Pay {name} + logo + description, themed by the
 * merchant's brand color — and runs the existing `contracts.ts` checkout when
 * the tenant has registered on-chain (a `merchantId`). When they have branded
 * but not yet registered, we show the branded card honestly and say payments
 * aren't switched on yet (no fake checkout, law #4).
 *
 * URL params: ?amount=29.00 (price), ?order=, ?return_url= (passed through to
 * the existing CheckoutCard).
 */
export function SlugCheckoutView({ slug }: { slug: string }): ReactNode {
  const searchParams = useSearchParams()
  const chainId = getDefaultChainId()

  const [branding, setBranding] = useState<PublicBranding | null>(null)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/branding/${encodeURIComponent(slug)}`)
        if (cancelled) return
        if (res.status === 404) {
          setLoadError('not_found')
          setLoading(false)
          return
        }
        const b = (await res.json()) as PublicBranding
        if (cancelled) return
        setBranding(b)

        // If they are on-chain, load the merchant record so we can take payment.
        if (b.merchantId) {
          try {
            const routerAddress = getRouterAddress(chainId)
            const client = getPublicClient(chainId)
            const m = await getMerchant(client, routerAddress, BigInt(b.merchantId))
            if (!cancelled && m.owner !== ZERO_ADDRESS) setMerchant(m)
          } catch {
            // Leave merchant null — we render the branded card without pay.
          }
        }
      } catch {
        if (!cancelled) setLoadError('load_failed')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [slug, chainId])

  const amount = searchParams.get('amount') ?? '29.00'
  const orderParam = searchParams.get('order') ?? undefined
  // Validate at the source: only an https: URL survives; a javascript:/data:/http:
  // /evil-origin value is dropped to undefined (no link rendered) — red-report C-1.
  const returnUrl = safeReturnUrl(searchParams.get('return_url'))

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
      {loading ? (
        <div className="h-64 animate-pulse rounded-2xl bg-neutral-100" />
      ) : loadError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {loadError === 'not_found'
            ? 'This payment link is not valid.'
            : 'Could not load this checkout. Please try again.'}
        </div>
      ) : branding ? (
        <section
          className="rounded-2xl border border-neutral-200 p-6"
          style={{ borderTopColor: branding.brandColor, borderTopWidth: 3 }}
        >
          <div className="mb-5">
            <BrandPreview
              name={branding.name}
              description={branding.description}
              logoSvg={branding.logoSvg || undefined}
              brandColor={branding.brandColor}
            />
            {/* Casino vertical (World prize): the "Verified Humans Only · World
                ID" badge. Renders ONLY when the operator is World ID-verified AND
                the checkout is verified-human AND World ID is configured; for a
                casino with World ID off it shows the honest "configure to verify"
                line instead of faking the green check (law #4 / fail-soft). */}
            <div className="mt-3">
              <CasinoVerifiedBadge
                verifiedOperator={branding.verifiedOperator}
                checkoutMode={branding.checkoutMode}
                vertical={branding.vertical}
                worldConfigured={isWorldIdConfigured()}
              />
            </div>
          </div>

          {branding.merchantId && merchant ? (
            <CheckoutCard
              chainId={chainId}
              merchantId={BigInt(branding.merchantId)}
              merchant={merchant}
              merchantName={branding.name}
              usdAmount={amount}
              orderParam={orderParam}
              returnUrl={returnUrl}
              requiredTier={branding.requiredTier}
              {...(() => {
                // Resolve the D0 choice (verified-human / private / standard),
                // enforcing mutual exclusion + fail-soft (resolveGate). A
                // verified-human merchant with World ID unconfigured degrades to
                // standard so a missing env never blocks pay (ADR D7).
                const gate = resolveGate(branding)
                return { checkoutMode: gate.mode, humanVerifier: gate.verifier }
              })()}
            />
          ) : (
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
              {branding.name} hasn&apos;t switched on payments yet. Check back soon.
            </div>
          )}

          <p className="mt-5 flex items-center justify-center gap-1.5 border-t border-neutral-100 pt-4 text-center text-xs text-neutral-400">
            <span>Powered by</span>
            <BrandMark size={14} />
          </p>
        </section>
      ) : null}

      <AskAssistant />
    </main>
  )
}
