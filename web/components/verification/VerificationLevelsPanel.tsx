'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'

import { ConnectButton } from '@/components/ConnectButton'
import { VerificationLevels } from './VerificationLevels'
import { loadProfile, type VerificationProfileResponse } from '@/lib/verification/client'

/**
 * VerificationLevelsPanel — a self-contained, read-only verification card for
 * places that want to SHOW the connected account's trust level (onboarding,
 * dashboard) without the full per-method action stack. It loads the profile and
 * renders the shadcn {@link VerificationLevels} ladder; the "Verify more" CTA
 * deep-links to /verify where the actions live. Off the money path.
 */
export function VerificationLevelsPanel({
  verifyHref = '/verify',
}: {
  verifyHref?: string
}): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const user = primaryWallet?.address?.toLowerCase() ?? null
  const [profile, setProfile] = useState<VerificationProfileResponse | null>(null)

  useEffect(() => {
    if (!user) {
      setProfile(null)
      return
    }
    let cancelled = false
    void loadProfile(user).then((p) => {
      if (!cancelled && p) setProfile(p)
    })
    return () => {
      cancelled = true
    }
  }, [user])

  if (!user) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="text-sm text-muted-foreground">
          Connect your wallet to see your verification level.
        </p>
        <ConnectButton />
      </div>
    )
  }

  return (
    <VerificationLevels
      methods={profile?.methods ?? []}
      score={profile?.score ?? 0}
      verifyHref={verifyHref}
    />
  )
}
