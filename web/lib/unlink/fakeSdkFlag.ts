/**
 * fakeSdkFlag.ts — the one switch that selects the in-repo FAKE shielded set.
 *
 * It lives in its own tiny module so `loadSdk.ts` can consult the flag without
 * importing `fakeSdk.ts` at all on the normal path: a deployment that never sets
 * the flag never even loads the fake's code.
 *
 * THE SAFETY RULE. The fake moves no money and settles nothing, so letting it
 * stand in for the real SDK in production would silently turn every "private
 * payout" into a no-op that REPORTS success — the worst possible failure for a
 * money path. The flag is therefore refused outright when `NODE_ENV=production`,
 * regardless of what the env says, and the refusal is loud in the log.
 */

/** The opt-in env var. Explicit `"true"` only — any other value is off. */
export const FAKE_SDK_FLAG = 'UNLINK_FAKE_SDK' as const

let refusalWarned = false

/**
 * Is the in-repo fake shielded set selected?
 *
 * @returns true only when `UNLINK_FAKE_SDK=true` AND this is not a production
 *          build. Production always returns false, with a one-time warning so an
 *          operator who set the flag by accident sees why it did nothing.
 */
export function fakeSdkEnabled(): boolean {
  const requested = (process.env[FAKE_SDK_FLAG] ?? '').trim().toLowerCase() === 'true'
  if (!requested) return false

  if (process.env.NODE_ENV === 'production') {
    warnRefusalOnce()
    return false
  }
  return true
}

function warnRefusalOnce(): void {
  if (refusalWarned) return
  refusalWarned = true
  console.warn(
    `[unlink/fakeSdk] ${FAKE_SDK_FLAG}=true was REFUSED: this is a production build. ` +
      'The fake shielded set settles nothing and moves no money — honouring it here would ' +
      'report successful private payouts that never happened. Install the real ' +
      '@unlink-xyz/sdk, or leave the seam dormant (503 not_configured).',
  )
}

/** Test-only: clear the one-time warning latch. */
export function __resetFakeSdkFlagWarning(): void {
  refusalWarned = false
}
