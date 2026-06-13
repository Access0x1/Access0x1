'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { ConnectButton } from '@/components/ConnectButton'
import { WorldIdGate } from '@/components/WorldIdGate'
import { SuperVerifiedBadge } from './SuperVerifiedBadge'
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

  const [profile, setProfile] = useState<VerificationProfileResponse | null>(null)
  const [busy, setBusy] = useState<VerificationMethod | null>(null)
  const [errors, setErrors] = useState<Partial<Record<VerificationMethod, string>>>({})
  const [ensName, setEnsName] = useState('')
  const [worldIdOpen, setWorldIdOpen] = useState(false)

  const refresh = useCallback(async () => {
    if (!user) return
    const p = await loadProfile(user)
    if (p) setProfile(p)
  }, [user])

  useEffect(() => {
    void refresh()
  }, [refresh])

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
        <p className="text-sm text-neutral-600">Connect your wallet to start verifying.</p>
        <ConnectButton />
      </div>
    )
  }

  const tier = profile?.tier ?? 'standard'
  const score = profile?.score ?? 0
  const nextStep = profile?.nextStep ?? null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-ink">Your verification</span>
          <SuperVerifiedBadge tier={tier} score={score} />
        </div>
        {/* Trust meter. */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
          <div
            className="h-full rounded-full bg-rail transition-all"
            style={{ width: `${score}%` }}
            role="progressbar"
            aria-valuenow={score}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
        {nextStep ? (
          <p className="text-sm text-neutral-600">{nextStep}</p>
        ) : (
          <p className="text-sm font-medium text-rail">
            ★ You&apos;re Super Verified — the highest trust tier.
          </p>
        )}
      </div>

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
                complete ? 'border-green-300 bg-green-50' : 'border-neutral-200'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <span className="font-medium text-ink">
                    {complete ? '✓ ' : ''}
                    {info.label}
                  </span>
                  <span className="text-sm text-neutral-500">{info.adds}</span>
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
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        value={ensName}
                        onChange={(e) => setEnsName(e.target.value)}
                        placeholder="yourname.eth"
                        className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
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
      return 'World ID isn’t switched on for this demo yet.'
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
