'use client'

import { useState, type ReactNode } from 'react'
import { ConnectButton } from '@/components/ConnectButton'
import { RegisterForm, type RegisterResult } from '@/components/RegisterForm'
import { LinkCard } from '@/components/LinkCard'
import { AskAssistant } from '@/components/AskAssistant'

/**
 * Onboarding view: connect wallet -> register merchant -> show link / QR /
 * snippet. After register, the merchantId is stashed in localStorage so the
 * dashboard can find the merchant's receipts later.
 *
 * Rendered client-only (the route wrapper imports it with ssr: false) so the
 * Dynamic wallet hooks never run during static generation.
 */
export function OnboardView(): ReactNode {
  const [result, setResult] = useState<RegisterResult | null>(null)

  function handleRegistered(r: RegisterResult): void {
    try {
      localStorage.setItem('ax1_merchant_id', r.merchantId.toString())
      localStorage.setItem('ax1_merchant_name', r.name)
    } catch {
      // localStorage may be unavailable (private mode) — non-fatal.
    }
    setResult(r)
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-rail">Access0x1</p>
          <h1 className="text-2xl font-semibold text-ink">Accept crypto with one link</h1>
        </div>
        <ConnectButton />
      </header>

      <section className="rounded-2xl border border-neutral-200 p-6">
        {result ? <LinkCard result={result} /> : <RegisterForm onRegistered={handleRegistered} />}
      </section>

      {result ? (
        <button
          type="button"
          onClick={() => setResult(null)}
          className="text-sm text-neutral-500 underline-offset-2 hover:underline"
        >
          Register another business
        </button>
      ) : (
        <p className="text-sm text-neutral-500">
          Onboard once, share the link, get paid in USDC. Zero custody — every payment settles
          straight to your payout address.
        </p>
      )}

      <AskAssistant />
    </main>
  )
}
