'use client'

import type { ReactNode } from 'react'

/**
 * FundButton — a small, standalone "get money into the wallet" control shown ONLY
 * when a funding seam is configured. Two ways:
 *   - "Fund with bank"   → the provider-agnostic fiat on-ramp (lib/onramp).
 *   - "One-tap deposit"  → the one-tap crypto deposit layer (lib/funding/blink).
 *
 * The USDC delivered by either path lands in the buyer/agent EOA and then flows
 * into the EXISTING pay path (CheckoutCard → payToken) — this control never
 * settles a payment itself.
 *
 * PURE BY DESIGN (so it renders in the vitest `node` env via React's static
 * renderer, the TokenPicker/VerificationLevels precedent): whether each option is
 * available is decided by the PARENT (CheckoutCard reads `isOnrampConfigured()` /
 * `isBlinkConfigured()` and passes the booleans + the action callbacks). With both
 * false the component returns `null` — the funding UI is HIDDEN when unconfigured,
 * never a dead button, never a guessed provider/address (law #4).
 */
export function FundButton({
  showBank = false,
  showOneTap = false,
  onFundWithBank,
  onOneTapDeposit,
  busy = false,
  note,
}: {
  /** True when the fiat on-ramp is configured (parent: isOnrampConfigured()). */
  showBank?: boolean
  /** True when one-tap deposit is configured (parent: isBlinkConfigured()). */
  showOneTap?: boolean
  /** Open the hosted fiat on-ramp. Required to actually enable the bank button. */
  onFundWithBank?: () => void
  /** Open the one-tap deposit flow. Required to actually enable that button. */
  onOneTapDeposit?: () => void
  /** Disable while a funding action is in flight (e.g. building a session). */
  busy?: boolean
  /** Optional status/error line under the buttons (honest copy, no secret). */
  note?: string | null
}): ReactNode {
  // Hidden-when-unconfigured: nothing renders unless at least one seam is on AND
  // its action is wired. This is the single gate that keeps the funding UI off a
  // clean / pre-booth build (fail-soft).
  const bank = showBank && typeof onFundWithBank === 'function'
  const oneTap = showOneTap && typeof onOneTapDeposit === 'function'
  if (!bank && !oneTap) return null

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border bg-secondary p-4"
      data-funding="true"
      data-bank={bank ? 'true' : 'false'}
      data-onetap={oneTap ? 'true' : 'false'}
    >
      <p className="text-sm text-neutral-600">Need funds? Top up this wallet, then pay.</p>
      <div className="flex flex-wrap gap-2">
        {bank ? (
          <button
            type="button"
            data-action="fund-bank"
            onClick={onFundWithBank}
            disabled={busy}
            className="rounded-lg border border-rail px-3 py-2 text-sm font-medium text-rail transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Opening…' : 'Fund with bank'}
          </button>
        ) : null}
        {oneTap ? (
          <button
            type="button"
            data-action="fund-onetap"
            onClick={onOneTapDeposit}
            disabled={busy}
            className="rounded-lg border border-rail px-3 py-2 text-sm font-medium text-rail transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Opening…' : 'One-tap deposit'}
          </button>
        ) : null}
      </div>
      {note ? <p className="text-xs text-neutral-500">{note}</p> : null}
    </div>
  )
}
