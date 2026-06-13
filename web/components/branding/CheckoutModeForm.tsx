'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import type { CheckoutMode } from '@/lib/branding/store'
import type { TrustTier } from '@/lib/verification/tiers'
import { loadBranding, saveCheckoutMode } from '@/lib/branding/client'
import { ConnectButton } from '@/components/ConnectButton'

/**
 * CheckoutModeForm — the plain-English "Who can pay you?" card (World ID ADR D0
 * / unit 3). Three picture-free, jargon-free options + the honest "opposite
 * poles" line. Sensible default (Anyone / standard). Shown as one optional step
 * at sign-up (after name/logo) and in Settings → Checkout.
 *
 * Non-coder law (ADR D5): the words Sybil / nullifier / zero-knowledge /
 * proof-of-personhood NEVER appear. Truth-in-copy: "verified people" says a real
 * unique person we never see; "private" says the trail is broken / confidential,
 * never "anonymous" or "untraceable".
 */

interface Option {
  value: CheckoutMode
  label: string
  helper: string
}

interface TierOption {
  value: TrustTier
  label: string
  helper: string
}

/**
 * The Super Verification buyer-tier gate (separate from identity-vs-privacy
 * above). "Anyone" is the default; "Verified" / "Super Verified" require the
 * buyer to have proven enough at /verify before they can pay.
 */
const TIER_OPTIONS: TierOption[] = [
  {
    value: 'standard',
    label: 'Anyone',
    helper: 'No verification needed to pay.',
  },
  {
    value: 'verified',
    label: 'Verified buyers',
    helper: 'The buyer must have proven at least one thing (World ID, an ENS name, sign-in, or a real wallet).',
  },
  {
    value: 'super-verified',
    label: 'Super Verified buyers only',
    helper: 'The strongest gate: World ID plus two more checks (or three checks total). Great for limited drops and high-trust sales.',
  },
]

const OPTIONS: Option[] = [
  {
    value: 'standard',
    label: 'Anyone',
    helper: 'The simple default. Anyone with a wallet can pay — nothing extra.',
  },
  {
    value: 'verified-human',
    label: 'Only verified real people (World ID)',
    helper:
      'Before someone can pay, they tap once to prove they’re a real, unique person — great for limited drops, free trials, and giveaways. Verified people only blocks bots and one-account-per-person. You never see their name or face — only a yes.',
  },
  {
    value: 'private',
    label: 'Private checkout (Unlink)',
    helper:
      'Keeps your revenue off the public ledger — the trail between who paid and where your money lands is broken, so your sales stay confidential. (Confidential, not anonymous — we’d never claim untraceable.)',
  },
]

export function CheckoutModeForm({
  mode = 'settings',
  onSaved,
}: {
  mode?: 'onboard' | 'settings'
  onSaved?: (m: CheckoutMode) => void
}): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const tenantId = primaryWallet?.address?.toLowerCase()

  const [choice, setChoice] = useState<CheckoutMode>('standard')
  const [requiredTier, setRequiredTier] = useState<TrustTier>('standard')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Prefill from the tenant's existing row.
  useEffect(() => {
    if (!tenantId) return
    let cancelled = false
    void loadBranding(tenantId).then((row) => {
      if (cancelled || !row) return
      setChoice(row.checkoutMode ?? 'standard')
      setRequiredTier(row.requiredTier ?? 'standard')
    })
    return () => {
      cancelled = true
    }
  }, [tenantId])

  async function handleSave(): Promise<void> {
    setError(null)
    setSaved(false)
    if (!tenantId) {
      setError('Sign in to choose who can pay you.')
      return
    }
    setSaving(true)
    const res = await saveCheckoutMode({ tenantId, checkoutMode: choice, requiredTier })
    setSaving(false)
    if (res.ok) {
      setSaved(true)
      onSaved?.(choice)
    } else {
      setError(res.error)
    }
  }

  if (!tenantId) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="text-sm text-neutral-600">
          Sign in to choose how customers pay you.
        </p>
        <ConnectButton />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-medium text-ink">Who can pay you, and how?</h2>
        <p className="text-sm text-neutral-500">
          Pick one. You can change this any time — and use a different choice on different products.
        </p>
      </div>

      <fieldset className="flex flex-col gap-3">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors ${
              choice === opt.value
                ? 'border-rail bg-neutral-50'
                : 'border-neutral-200 hover:border-neutral-300'
            }`}
          >
            <input
              type="radio"
              name="checkout-mode"
              value={opt.value}
              checked={choice === opt.value}
              onChange={() => setChoice(opt.value)}
              className="mt-1 h-4 w-4 accent-rail"
            />
            <span className="flex flex-col gap-1">
              <span className="font-medium text-ink">{opt.label}</span>
              <span className="text-sm text-neutral-500">{opt.helper}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <p className="rounded-lg bg-neutral-50 p-3 text-xs text-neutral-500">
        These pull in opposite directions. “Verified people” is about proving who someone is;
        “Private” is about hiding the trail. For a single payment you pick one — you can’t both
        prove who someone is and hide who they are at the same moment. We give you both; you choose.
      </p>

      <div className="flex flex-col gap-3 border-t border-neutral-100 pt-5">
        <div>
          <h2 className="font-medium text-ink">How verified must buyers be?</h2>
          <p className="text-sm text-neutral-500">
            Buyers raise their trust at the verification page. Require a tier and only buyers who
            meet it can pay.
          </p>
        </div>
        <fieldset className="flex flex-col gap-3">
          {TIER_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors ${
                requiredTier === opt.value
                  ? 'border-rail bg-neutral-50'
                  : 'border-neutral-200 hover:border-neutral-300'
              }`}
            >
              <input
                type="radio"
                name="required-tier"
                value={opt.value}
                checked={requiredTier === opt.value}
                onChange={() => setRequiredTier(opt.value)}
                className="mt-1 h-4 w-4 accent-rail"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium text-ink">{opt.label}</span>
                <span className="text-sm text-neutral-500">{opt.helper}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {saved && !error ? <p className="text-sm text-green-600">Changes saved.</p> : null}

      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving}
        className="self-start rounded-lg bg-rail px-4 py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? 'Saving…' : mode === 'onboard' ? 'Save my choice' : 'Save changes'}
      </button>
    </div>
  )
}
