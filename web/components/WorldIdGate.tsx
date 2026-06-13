'use client'

import { useCallback, useState, type ReactNode } from 'react'
import {
  IDKitRequestWidget,
  orbLegacy,
  selfieCheckLegacy,
  type IDKitResult,
  type RpContext,
} from '@worldcoin/idkit'
import { worldAction, worldAppId } from '@/lib/worldid/config'

/**
 * WorldIdGate — the ONLY component that imports `@worldcoin/idkit` (World ID ADR
 * D2). It renders the IDKit widget that bridges to World App: the user taps once
 * to prove they're a real, unique human, the widget hands us a ZK proof, we POST
 * it raw to `/api/world/verify`, and on a 200 we call `onVerified()` so the
 * checkout unlocks the pay button.
 *
 * Plain-English, non-coder UI (ADR D5): the merchant's buyer sees "Verify you're
 * a real person" — never the words nullifier / zero-knowledge / Sybil. We never
 * show an address or hash. Fail-soft: a rejected/failed proof shows a friendly
 * line and lets them retry; it never throws into the money path.
 *
 * `signal` binds the connected wallet into the proof so a proof can't be swapped
 * onto a different payer (ADR security note). `useSelfieCheck` picks the
 * lower-friction Selfie tier instead of Orb when the merchant chose it.
 */
export function WorldIdGate({
  signal,
  onVerified,
  action = worldAction(),
  useSelfieCheck = false,
  verifyUrl = '/api/world/verify',
  extraBody,
}: {
  /** The connected wallet address bound into the proof (anti-swap). */
  signal?: string
  /** Called once the backend returns a 200 (verified + first use). */
  onVerified: () => void
  /** The action string scoping this gate (defaults to the buyer-gate action). */
  action?: string
  /** Use the Selfie Check preset (no Orb needed) instead of Orb tier. */
  useSelfieCheck?: boolean
  /**
   * Where to POST the raw proof. Defaults to the buyer-gate route
   * (`/api/world/verify`); the Super Verification stack points it at
   * `/api/verify` so the SAME proof is verified + recorded on the trust profile
   * in ONE round-trip (no double nullifier claim). Both routes do the identical
   * verify+claim, so the proof is forwarded AS-IS either way.
   */
  verifyUrl?: string
  /** Extra fields merged into the POST body (e.g. `{ user, method }` for the trust stack). */
  extraBody?: Record<string, unknown>
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<'idle' | 'verifying' | 'verified' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [rpContext, setRpContext] = useState<RpContext | null>(null)

  const appId = worldAppId()
  const preset = useSelfieCheck ? selfieCheckLegacy({ signal }) : orbLegacy({ signal })

  // Fetch a fresh RP context from the server, then open the widget. The signing
  // key never leaves the server; we only receive the public rp_context.
  const start = useCallback(async () => {
    setMessage(null)
    setStatus('verifying')
    try {
      const res = await fetch('/api/world/sign')
      if (!res.ok) {
        setStatus('error')
        setMessage(
          res.status === 503
            ? 'Verification is not switched on for this checkout yet.'
            : 'Could not start verification. Please try again.',
        )
        return
      }
      const ctx = (await res.json()) as RpContext
      setRpContext(ctx)
      setOpen(true)
    } catch {
      setStatus('error')
      setMessage('Could not start verification. Please try again.')
    }
  }, [])

  // The widget hands us the raw proof; forward it AS-IS to our backend.
  const handleVerify = useCallback(
    async (result: IDKitResult) => {
      const res = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Forward the raw IDKit payload + the action (no field remap) + any
        // extra envelope the caller needs (e.g. { user, method } for the trust
        // profile). The proof fields stay untouched so portal verify still works.
        body: JSON.stringify({ ...result, action, ...extraBody }),
      })
      if (res.status === 409) {
        // One human, one shot — this person already used this action.
        throw new Error('already_verified')
      }
      if (!res.ok) throw new Error('verify_failed')
    },
    [action, verifyUrl, extraBody],
  )

  const onSuccess = useCallback(() => {
    setStatus('verified')
    setMessage(null)
    onVerified()
  }, [onVerified])

  const onError = useCallback(() => {
    setStatus('error')
    // handleVerify threw, or the user cancelled — keep it friendly and retryable.
    setMessage('We could not verify you. You can try again.')
  }, [])

  // Not configured (no public app id) — the gate degrades; the checkout should
  // not even mount us, but guard anyway so we never render a broken widget.
  if (!appId.startsWith('app_')) {
    return (
      <p className="text-sm text-neutral-500">
        Verification is not switched on for this checkout yet.
      </p>
    )
  }

  if (status === 'verified') {
    return (
      <p className="text-sm font-medium text-green-600">
        ✓ You&apos;re verified as a real person. You can pay now.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void start()}
        disabled={status === 'verifying'}
        className="rounded-lg border border-rail px-4 py-3 font-medium text-rail transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'verifying' ? 'Starting…' : 'Verify you’re a real person'}
      </button>
      <p className="text-xs text-neutral-500">
        Tap once to prove you’re a real, unique person. We never see your name or face — only a yes.
      </p>
      {message ? (
        <p className="text-sm text-red-600">
          {message === 'already_verified'
            ? 'This account has already been used once for this. One per person.'
            : message}
        </p>
      ) : null}

      {rpContext ? (
        <IDKitRequestWidget
          app_id={appId as `app_${string}`}
          action={action}
          rp_context={rpContext}
          preset={preset}
          // orbLegacy/selfieCheckLegacy return World ID 3.0 proofs — accept them.
          allow_legacy_proofs
          open={open}
          onOpenChange={setOpen}
          handleVerify={handleVerify}
          onSuccess={onSuccess}
          onError={onError}
          autoClose
        />
      ) : null}
    </div>
  )
}
