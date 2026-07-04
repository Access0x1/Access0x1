'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { ConnectButton } from '@/components/ConnectButton'
import { WorldIdGate } from '@/components/WorldIdGate'
import { usePrimaryEnsName } from '@/lib/ens/usePrimaryEnsName'
import { VerificationLevels } from './VerificationLevels'
import {
  METHOD_INFO,
  VERIFICATION_METHODS,
  type VerificationMethod,
} from '@/lib/verification/tiers'
import {
  loadProfile,
  verifyMethod,
  type VerificationProfileResponse,
} from '@/lib/verification/client'

/**
 * VerificationStack — the Super Verification panel. Shows every way to verify,
 * what each one adds, the badge earned so far, and a "verify more -> Super
 * Verified" nudge. Each row kicks off a REAL check via /api/verify; the server
 * does the verification and returns the fresh profile/tier.
 *
 * Plain-English, non-coder UI: no jargon (nullifier / ZK / resolver). World ID
 * composes the existing WorldIdGate (the only IDKit consumer); ENS takes the
 * user's .eth name and the server checks it forward-resolves to their wallet;
 * "Signed in" and "Real wallet" are one-tap (the server verifies the session /
 * reads the chain). Fail-soft: a method that isn't switched on yet shows a
 * friendly line and never blocks the others.
 */
export function VerificationStack(): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const user = primaryWallet?.address?.toLowerCase() ?? null

  // Recognize the connected wallet's OWN primary ENS name (mainnet, coinType 60 —
  // the identity namespace). When set, we surface it as already-recognized and
  // prefill the manual field, so the user doesn't have to type a name they've
  // already set. Dormant-safe: no wallet ⇒ no fetch, recognizedName null.
  const { name: recognizedName } = usePrimaryEnsName(primaryWallet?.address)

  const [profile, setProfile] = useState<VerificationProfileResponse | null>(null)
  const [busy, setBusy] = useState<VerificationMethod | null>(null)
  const [errors, setErrors] = useState<Partial<Record<VerificationMethod, string>>>({})
  const [ensName, setEnsName] = useState('')
  // Whether the user has touched the ENS field — once they type, we stop
  // auto-prefilling so we never clobber a name they're deliberately asserting.
  const [ensTouched, setEnsTouched] = useState(false)
  const [worldIdOpen, setWorldIdOpen] = useState(false)

  const refresh = useCallback(async () => {
    if (!user) return
    const p = await loadProfile(user)
    if (p) setProfile(p)
  }, [user])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Prefill the manual ENS field with the recognized primary name — but only
  // until the user edits it (ensTouched), so the manual "assert a different name"
  // path is never overwritten. Augments the manual path; never replaces it.
  useEffect(() => {
    if (recognizedName && !ensTouched) setEnsName(recognizedName)
  }, [recognizedName, ensTouched])

  const done = useCallback(
    (m: VerificationMethod) => (profile?.methods.includes(m) ?? false),
    [profile],
  )

  const run = useCallback(
    async (method: VerificationMethod, extra?: Record<string, unknown>) => {
      if (!user) return
      setBusy(method)
      setErrors((e) => ({ ...e, [method]: undefined }))
      const res = await verifyMethod(user, method, extra)
      setBusy(null)
      if (res.ok) {
        setProfile(res.profile)
        if (method === 'world-id') setWorldIdOpen(false)
      } else {
        setErrors((e) => ({ ...e, [method]: friendlyError(method, res.error) }))
      }
    },
    [user],
  )

  if (!user) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="text-sm text-muted-foreground">Connect your wallet to start verifying.</p>
        <ConnectButton />
      </div>
    )
  }

  const methods = profile?.methods ?? []
  const score = profile?.score ?? 0

  return (
    <div className="flex flex-col gap-6">
      {/* The shadcn ladder panel: trust meter, method chips, current level, and
          the "Verify more" CTA. Pure/presentational — this stack owns the data
          and the per-method actions below. */}
      <VerificationLevels methods={methods} score={score} />

      <ul className="flex flex-col gap-3">
        {VERIFICATION_METHODS.map((method) => {
          const info = METHOD_INFO[method]
          const complete = done(method)
          const isBusy = busy === method
          const err = errors[method]
          return (
            <li
              key={method}
              className={`rounded-xl border p-4 transition-colors ${
                complete ? 'border-green-300 bg-green-50' : 'border-border'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <span className="font-medium text-ink">
                    {complete ? '✓ ' : ''}
                    {info.label}
                  </span>
                  <span className="text-sm text-muted-foreground">{info.adds}</span>
                </div>
                {complete ? (
                  <span className="shrink-0 text-sm font-medium text-green-700">Verified</span>
                ) : null}
              </div>

              {/* Per-method action (only when not yet complete). */}
              {!complete ? (
                <div className="mt-3">
                  {method === 'world-id' ? (
                    worldIdOpen ? (
                      <WorldIdGate
                        signal={user}
                        // Post the proof straight to /api/verify so the SAME proof
                        // is verified + claimed + recorded on the trust profile in
                        // one round-trip (no double nullifier claim).
                        verifyUrl="/api/verify"
                        extraBody={{ user, method: 'world-id' }}
                        onVerified={() => {
                          setWorldIdOpen(false)
                          void refresh()
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setWorldIdOpen(true)}
                        className="rounded-lg border border-rail px-3 py-2 text-sm font-medium text-rail hover:opacity-90"
                      >
                        Verify with World ID
                      </button>
                    )
                  ) : method === 'ens' ? (
                    <div className="flex flex-col gap-2">
                      {/* Auto-recognized primary name (mainnet). Shown as
                          already-found with a one-tap verify, so the user
                          doesn't retype a name they've already set. */}
                      {recognizedName ? (
                        <div className="flex flex-col gap-2 rounded-lg border border-green-300 bg-green-50 p-3 sm:flex-row sm:items-center sm:justify-between">
                          <span className="text-sm text-green-800">
                            ✓ <span className="font-medium">{recognizedName}</span> — your primary
                            name
                          </span>
                          <button
                            type="button"
                            onClick={() => void run('ens', { ensName: recognizedName })}
                            disabled={isBusy}
                            className="shrink-0 rounded-lg border border-rail px-3 py-2 text-sm font-medium text-rail hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isBusy ? 'Checking…' : `Verify ${recognizedName}`}
                          </button>
                        </div>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {recognizedName
                          ? 'We recognized your primary ENS name from your wallet. You can verify it above, or enter a different name to assert instead.'
                          : 'Enter the ENS name that points to this wallet. We recognize your primary name from your wallet automatically when you have one set.'}
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                          type="text"
                          value={ensName}
                          onChange={(e) => {
                            setEnsTouched(true)
                            setEnsName(e.target.value)
                          }}
                          placeholder="yourname.eth"
                          className="flex-1 rounded-lg border border-input px-3 py-2 text-sm"
                          aria-label="Your ENS name"
                        />
                        <button
                          type="button"
                          onClick={() => void run('ens', { ensName })}
                          disabled={isBusy || !ensName.trim()}
                          className="rounded-lg border border-rail px-3 py-2 text-sm font-medium text-rail hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isBusy ? 'Checking…' : 'Check ENS'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void run(method)}
                      disabled={isBusy}
                      className="rounded-lg border border-rail px-3 py-2 text-sm font-medium text-rail hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isBusy
                        ? 'Checking…'
                        : method === 'dynamic'
                          ? 'Confirm I’m signed in'
                          : 'Check my wallet'}
                    </button>
                  )}
                  {err ? <p className="mt-2 text-sm text-red-600">{err}</p> : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Map a server code to plain-English, non-coder copy (law: no raw errors). */
function friendlyError(method: VerificationMethod, code: string): string {
  switch (code) {
    case 'not_configured':
      return 'World ID isn’t switched on yet.'
    case 'already_verified':
      return 'This account already verified once. One per person.'
    case 'proof_invalid':
      return 'We couldn’t verify that proof. Please try again.'
    case 'ens_mismatch':
      return 'That ENS name points to a different wallet than the one you’re connected with.'
    case 'ens_unresolved':
      return 'We couldn’t resolve that ENS name. Check the spelling.'
    case 'ens_unreachable':
      return 'The ENS resolver is unreachable right now. Try again shortly.'
    case 'wallet_empty':
      return 'This wallet has no funds or history yet — fund it or make a payment first.'
    case 'onchain_unreachable':
      return 'We couldn’t reach the network to check your wallet. Try again shortly.'
    case 'dynamic_unauthorized':
    case 'dynamic_mismatch':
      return 'We couldn’t confirm your sign-in. Reconnect and try again.'
    default:
      return method === 'ens' ? 'Could not verify that ENS name.' : 'Could not verify. Please try again.'
  }
}
