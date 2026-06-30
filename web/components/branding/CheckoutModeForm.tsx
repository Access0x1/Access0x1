'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import type { CheckoutMode, MerchantVertical } from '@/lib/branding/store'
import type { TrustTier } from '@/lib/verification/tiers'
import { loadBranding, loadOperatorVerified, saveCheckoutMode } from '@/lib/branding/client'
import { isWorldIdConfigured, worldOperatorAction } from '@/lib/worldid/config'
import { WorldIdGate } from '@/components/WorldIdGate'
import { CasinoVerifiedBadge } from '@/components/CasinoVerifiedBadge'

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
  const [vertical, setVertical] = useState<MerchantVertical>('standard')
  const [operatorVerified, setOperatorVerified] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const isCasino = vertical === 'casino'
  const worldConfigured = isWorldIdConfigured()
  // A casino is FORCED to verified-human (players pass the World ID gate); the
  // radios below are locked so it is not operator-overridable while casino.
  const effectiveMode: CheckoutMode = isCasino ? 'verified-human' : choice

  // Prefill from the tenant's existing row.
  useEffect(() => {
    if (!tenantId) return
    let cancelled = false
    void loadBranding(tenantId).then((row) => {
      if (cancelled || !row) return
      setChoice(row.checkoutMode ?? 'standard')
      setRequiredTier(row.requiredTier ?? 'standard')
      setVertical(row.vertical ?? 'standard')
      setOperatorVerified(row.verifiedOperator === true)
    })
    return () => {
      cancelled = true
    }
  }, [tenantId])

  // After the operator completes World ID, re-read the row so the flag + badge
  // reflect the server truth (the gate POSTed to /operator-verify).
  async function refreshOperator(): Promise<void> {
    if (!tenantId) return
    setOperatorVerified(await loadOperatorVerified(tenantId))
  }

  async function handleSave(): Promise<void> {
    setError(null)
    setSaved(false)
    if (!tenantId) {
      setError('Sign in to choose who can pay you.')
      return
    }
    // Front-stop: a casino cannot be saved until the operator is World ID-verified.
    // The server enforces this too (CASINO_NEEDS_OPERATOR) — this is just a clearer
    // local message before the round-trip.
    if (isCasino && !operatorVerified) {
      setError(
        'Casinos must verify with World ID before going live. Complete the World ID step above to prove a real person is running this casino.',
      )
      return
    }
    setSaving(true)
    const res = await saveCheckoutMode({
      tenantId,
      checkoutMode: effectiveMode,
      requiredTier,
      vertical,
    })
    setSaving(false)
    if (res.ok) {
      setSaved(true)
      onSaved?.(effectiveMode)
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
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Casino vertical (World prize): World ID is load-bearing. Marking the
          business a casino FORCES verified-human and requires the operator to
          complete World ID before the casino can go live. */}
      <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            name="vertical-casino"
            checked={isCasino}
            onChange={(e) => {
              setVertical(e.target.checked ? 'casino' : 'standard')
              setSaved(false)
              setError(null)
            }}
            className="mt-1 h-4 w-4 accent-rail"
          />
          <span className="flex flex-col gap-1">
            <span className="font-medium text-ink">This is a casino (play or wagering access)</span>
            <span className="text-sm text-neutral-600">
              Casinos must verify with World ID. Verifying proves a real, unique person is running
              the casino and makes every player pass the World ID gate — so your checkout shows the
              “Verified Humans Only · World ID” badge. World ID proves a unique human only; it is not
              a gambling licence, age check, or eligibility check.
            </span>
          </span>
        </label>

        {isCasino ? (
          operatorVerified ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-green-700" data-operator-verified="true">
                ✓ You verified with World ID. This casino can go live.
              </p>
              <CasinoVerifiedBadge
                verifiedOperator={operatorVerified}
                checkoutMode="verified-human"
                vertical="casino"
                worldConfigured={worldConfigured}
              />
            </div>
          ) : worldConfigured ? (
            <div className="flex flex-col gap-2" data-operator-step="required">
              <p className="text-sm font-medium text-ink">
                Step required: verify with World ID to make this casino trustworthy.
              </p>
              {tenantId ? (
                <WorldIdGate
                  signal={tenantId}
                  action={worldOperatorAction()}
                  verifyUrl="/api/branding/operator-verify"
                  extraBody={{ tenantId }}
                  onVerified={() => void refreshOperator()}
                />
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-amber-700" data-operator-step="unconfigured">
              World ID required — configure World ID to verify this casino. Until then this casino
              cannot go live and the badge cannot be issued.
            </p>
          )
        ) : null}
      </div>

      <div>
        <h2 className="font-medium text-ink">Who can pay you, and how?</h2>
        <p className="text-sm text-neutral-500">
          {isCasino
            ? 'Casinos are set to verified real people (World ID) — this is locked while “casino” is on.'
            : 'Pick one. You can change this any time — and use a different choice on different products.'}
        </p>
      </div>

      <fieldset className="flex flex-col gap-3" disabled={isCasino}>
        {OPTIONS.map((opt) => {
          const selected = effectiveMode === opt.value
          return (
            <label
              key={opt.value}
              className={`flex gap-3 rounded-xl border p-4 transition-colors ${
                isCasino ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
              } ${
                selected
                  ? 'border-rail bg-neutral-50'
                  : 'border-neutral-200 hover:border-neutral-300'
              }`}
            >
              <input
                type="radio"
                name="checkout-mode"
                value={opt.value}
                checked={selected}
                disabled={isCasino}
                onChange={() => setChoice(opt.value)}
                className="mt-1 h-4 w-4 accent-rail"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium text-ink">{opt.label}</span>
                <span className="text-sm text-neutral-500">{opt.helper}</span>
              </span>
            </label>
          )
        })}
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
        disabled={saving || (isCasino && !operatorVerified)}
        className="self-start rounded-lg bg-rail px-4 py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving
          ? 'Saving…'
          : isCasino && !operatorVerified
            ? 'Verify with World ID to finish'
            : mode === 'onboard'
              ? 'Save my choice'
              : 'Save changes'}
      </button>
    </div>
  )
}
