'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { ConnectButton } from '@/components/ConnectButton'
import { WorldIdGate } from '@/components/WorldIdGate'
import { usePrimaryEnsName } from '@/lib/ens/usePrimaryEnsName'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SuperVerifiedBadge } from './SuperVerifiedBadge'
import {
  LADDER_RUNGS,
  RUNG_INFO,
  nextLadderAction,
  rungFor,
  type LadderNextAction,
  type LadderRung,
} from '@/lib/verification/ladder'
import type { VerificationMethod } from '@/lib/verification/tiers'
import {
  loadProfile,
  verifyMethod,
  type VerificationProfileResponse,
} from '@/lib/verification/client'

/**
 * VerificationLadder — the ONE simple verification surface (○ → ✓ → ✓✓).
 *
 * Replaces the old all-providers panel: instead of five method rows with five
 * buttons, the user sees the three-rung chip and EXACTLY ONE button — the next
 * step, chosen for them by lib/verification/ladder.ts:
 *   ○  Connected       — wallet connected.
 *   ✓  Verified        — one tap: a recognized ENS name OR the World ID check.
 *   ✓✓ Super Verified  — both strong proofs + a confirmed sign-in.
 *
 * The full trust model (score, five methods, merchant gate) is unchanged
 * underneath — /api/verify still records every method; this surface just walks
 * the user up one rung at a time. Fail-soft: a method that isn't switched on
 * routes to the next useful step instead of dead-ending.
 */
export function VerificationLadder(): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const user = primaryWallet?.address?.toLowerCase() ?? null

  // The wallet's recognized primary ENS name (forward==reverse) makes the ENS
  // proof a single tap — the ladder prefers it. Dormant-safe: no wallet, no fetch.
  const { name: recognizedName } = usePrimaryEnsName(primaryWallet?.address)

  const [profile, setProfile] = useState<VerificationProfileResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ensName, setEnsName] = useState('')
  const [worldIdOpen, setWorldIdOpen] = useState(false)
  const [worldIdUnavailable, setWorldIdUnavailable] = useState(false)

  const refresh = useCallback(async () => {
    if (!user) return
    const p = await loadProfile(user)
    if (p) setProfile(p)
  }, [user])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(
    async (method: VerificationMethod, extra?: Record<string, unknown>) => {
      if (!user) return
      setBusy(true)
      setError(null)
      const res = await verifyMethod(user, method, extra)
      setBusy(false)
      if (res.ok) {
        setProfile(res.profile)
        setWorldIdOpen(false)
        setEnsName('')
      } else if (method === 'world-id' && res.error === 'not_configured') {
        // World ID is off on this deploy — reroute instead of dead-ending.
        setWorldIdOpen(false)
        setWorldIdUnavailable(true)
      } else {
        setError(friendlyError(method, res.error))
      }
    },
    [user],
  )

  if (!user) {
    return (
      <div className="flex flex-col items-start gap-4">
        <LadderChips rung={0} connected={false} />
        <p className="text-sm text-muted-foreground">
          Connect your wallet to start climbing — three rungs, one step at a time.
        </p>
        <ConnectButton />
      </div>
    )
  }

  const methods = profile?.methods ?? []
  const rung = rungFor(methods)
  const action = nextLadderAction(methods, {
    hasRecognizedEnsName: Boolean(recognizedName),
    worldIdUnavailable,
  })
  // The ENS proof needs a typed name only when no primary name was recognized.
  const ensInputNeeded = action?.method === 'ens' && !recognizedName

  return (
    <LadderView
      rung={rung}
      score={profile?.score}
      action={action}
      busy={busy}
      error={error}
      recognizedName={recognizedName}
      ensInputNeeded={ensInputNeeded}
      ensName={ensName}
      onEnsNameChange={setEnsName}
      worldIdOpen={worldIdOpen}
      worldIdGate={
        worldIdOpen ? (
          <WorldIdGate
            signal={user}
            // POST straight to /api/verify so the same proof is verified +
            // claimed + recorded on the trust profile in one round-trip.
            verifyUrl="/api/verify"
            extraBody={{ user, method: 'world-id' }}
            onVerified={() => {
              setWorldIdOpen(false)
              void refresh()
            }}
          />
        ) : null
      }
      onAction={(a) => {
        if (a.method === 'world-id') setWorldIdOpen(true)
        else if (a.method === 'ens')
          void run('ens', { ensName: recognizedName ?? ensName })
        else void run(a.method)
      }}
    />
  )
}

/**
 * LadderView — the pure, SSR-testable rendering of the ladder: the three-rung
 * chip row, the current rung's line, and the ONE next-step control (or the
 * Super Verified badge at the top). The container above owns all data/actions.
 */
export function LadderView({
  rung,
  score,
  action,
  busy = false,
  error = null,
  recognizedName = null,
  ensInputNeeded = false,
  ensName = '',
  onEnsNameChange,
  worldIdOpen = false,
  worldIdGate = null,
  onAction,
}: {
  rung: LadderRung
  score?: number
  action: LadderNextAction | null
  busy?: boolean
  error?: string | null
  recognizedName?: string | null
  ensInputNeeded?: boolean
  ensName?: string
  onEnsNameChange?: (v: string) => void
  worldIdOpen?: boolean
  worldIdGate?: ReactNode
  onAction?: (action: LadderNextAction) => void
}): ReactNode {
  // The one-tap ENS button verifies the recognized name by name.
  const actionLabel =
    action?.method === 'ens' && recognizedName ? `Verify ${recognizedName}` : action?.label

  return (
    <div className="flex flex-col gap-5">
      <LadderChips rung={rung} connected />

      {rung === 2 ? (
        <div className="flex items-center gap-3">
          <SuperVerifiedBadge tier="super-verified" score={score} />
          <p className="text-sm text-muted-foreground">
            Every rung climbed — merchants that require the top tier accept you.
          </p>
        </div>
      ) : action ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{action.hint}</p>

          {worldIdOpen && action.method === 'world-id' ? (
            worldIdGate
          ) : ensInputNeeded ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                id="ladder-ens-name"
                name="ens-name"
                autoComplete="off"
                value={ensName}
                onChange={(e) => onEnsNameChange?.(e.target.value)}
                placeholder="yourname.eth"
                className="flex-1 rounded-lg border border-input px-3 py-2 text-sm"
                aria-label="Your ENS name"
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || !ensName.trim()}
                onClick={() => action && onAction?.(action)}
                className="shrink-0"
              >
                {busy ? 'Checking…' : 'Check name'}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => action && onAction?.(action)}
              className="self-start"
            >
              {busy ? 'Checking…' : actionLabel}
            </Button>
          )}

          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing more to verify right now — the remaining check isn’t switched on
          in this deployment.
        </p>
      )}
    </div>
  )
}

/**
 * The three-rung chip row: ○ → ✓ → ✓✓, the earned rungs lit, the current one
 * marked. Purely visual; `connected=false` greys the whole row (signed out).
 */
function LadderChips({
  rung,
  connected,
}: {
  rung: LadderRung
  connected: boolean
}): ReactNode {
  return (
    <ol className="flex items-center gap-2" aria-label="Verification ladder">
      {LADDER_RUNGS.map((r) => {
        const info = RUNG_INFO[r]
        const earned = connected && r <= rung
        const current = connected && r === rung
        return (
          <li key={r} className="flex items-center gap-2">
            {r > 0 ? <span className="text-muted-foreground/50" aria-hidden>→</span> : null}
            <Badge
              variant={earned ? (r === 2 ? 'super' : 'success') : 'outline'}
              className={!earned ? 'opacity-60' : undefined}
              data-rung={r}
              aria-current={current ? 'step' : undefined}
            >
              {info.symbol} {info.label}
            </Badge>
          </li>
        )
      })}
    </ol>
  )
}

/** Server code → plain-English copy (law: never show a raw error). */
function friendlyError(method: VerificationMethod, code: string): string {
  switch (code) {
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
    case 'dynamic_unauthorized':
    case 'dynamic_mismatch':
      return 'We couldn’t confirm your sign-in. Reconnect and try again.'
    default:
      return method === 'ens'
        ? 'Could not verify that ENS name.'
        : 'Could not verify. Please try again.'
  }
}
