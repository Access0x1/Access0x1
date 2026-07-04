'use client'

import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import type { ReactNode } from 'react'
import { IdentityChip } from '@/components/IdentityChip'

/**
 * Thin wrapper around Dynamic's auth flow. The button says "Sign in" (not "Connect
 * wallet") because the flow is universal: a crypto user picks a wallet, while a
 * non-crypto user continues with email or Google and Dynamic mints an embedded
 * wallet — "Connect wallet" reads as wallet-required and bounces the very users the
 * email/Google door is for. All connection goes through Dynamic (`setShowAuthFlow`)
 * — no wagmi `useConnect`.
 *
 * SINGLE-CTA rule: a page must never show two identical primary buttons. The
 * `variant` prop lets a header render a low-emphasis `ghost` sign-in while the
 * hero gate keeps the ONE `primary` cyan pill:
 *   - 'primary' (default) — the filled cyan pill, the page's single hero CTA.
 *   - 'ghost' — a small outlined/text sign-in for headers, so it doesn't compete
 *     with the hero.
 *
 * When signed in, both variants render the IdentityChip (identity + wallet
 * provenance + sign out) — the variant only styles the signed-OUT button.
 */
export function ConnectButton({
  variant = 'primary',
}: {
  variant?: 'primary' | 'ghost'
} = {}): ReactNode {
  const { primaryWallet, setShowAuthFlow } = useDynamicContext()

  // Signed in: the identity + provenance panel (shared across variants).
  if (primaryWallet) return <IdentityChip />

  if (variant === 'ghost') {
    return (
      <button
        type="button"
        onClick={() => setShowAuthFlow(true)}
        className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-rail hover:text-rail"
      >
        Sign in
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setShowAuthFlow(true)}
      className="rounded-lg bg-rail px-4 py-2 font-medium text-primary-foreground transition-opacity hover:opacity-90"
    >
      Sign in
    </button>
  )
}
