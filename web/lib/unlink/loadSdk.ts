/**
 * loadSdk.ts — the OPTIONAL/dynamic loader for the proprietary `@unlink-xyz/sdk`.
 *
 * WHY THIS EXISTS
 * ----------------
 * The Unlink SDK is a booth-installed proprietary package; off a clean `main`
 * only the local TYPE shim (`types/unlink-sdk.d.ts`) is present, not the runtime
 * package. A STATIC `import { account } from "@unlink-xyz/sdk"` makes `next build`
 * (webpack) HARD-FAIL with "Module not found" before the booth even opens.
 *
 * THE FIX (fail-soft, doctrine: isolate a missing dependency, never wedge the
 * whole build): load the SDK at CALL TIME via a guarded dynamic `import()` and
 * surface a clear, recoverable error when it is absent. The private-payout path
 * then degrades gracefully — `next build` succeeds without the package, the
 * checkout/agent paths are untouched, and a payout attempt without the SDK
 * returns a clean "not configured" error instead of crashing module load.
 *
 * `@unlink-xyz/sdk` is also declared a webpack server external in
 * `next.config.ts` so webpack emits a runtime resolve (this dynamic import)
 * rather than trying to bundle a package that isn't installed.
 *
 * Vitest is unaffected: each unlink test still `vi.mock("@unlink-xyz/sdk", …)`,
 * and `vi.mock` intercepts this dynamic import exactly as it did the static one.
 */

/**
 * The narrow runtime surface this app consumes from the Unlink SDK. Pulled from
 * the module's own type (the local shim, or the real package at the booth) so it
 * can never drift from the four bindings we actually use: `account`,
 * `buildDeriveSeedMessage`, `createUnlinkAdmin`, `createUnlinkClient`.
 */
export type UnlinkSdk = Pick<
  typeof import('@unlink-xyz/sdk'),
  'account' | 'buildDeriveSeedMessage' | 'createUnlinkAdmin' | 'createUnlinkClient'
>

/**
 * Thrown when a private-payout path is exercised but the proprietary SDK is not
 * installed (the pre-booth state). `recoverable` mirrors the money-path law (#5)
 * convention used by `WithdrawFailedError`: no funds moved, the operation can be
 * retried once the package is present — the caller surfaces a clean config error
 * rather than a stack trace, and NEVER a secret.
 */
export class UnlinkSdkUnavailableError extends Error {
  readonly recoverable = true as const
  readonly code = 'unlink_sdk_unavailable' as const
  constructor(cause?: unknown) {
    super(
      'unlink_sdk_unavailable: @unlink-xyz/sdk is not installed in this build ' +
        '(install it at the booth). The private payout leg is unavailable; no funds moved.',
    )
    this.name = 'UnlinkSdkUnavailableError'
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

/**
 * Thrown when the SDK is present but the payout seam has no credentials — the
 * SAME shape of non-event as {@link UnlinkSdkUnavailableError}: nothing moved,
 * nothing is broken, and it becomes possible the moment an operator fills the
 * env in. It exists because those cases used to fall to a generic 500, which
 * told an operator their deployment was faulty when it was merely dormant
 * (law #1).
 *
 * The message names the missing VARIABLE (never its value) because this error
 * is read in server logs, where "which one?" is the only question that matters.
 * It is safe to be specific here precisely because the HTTP layer does not
 * forward the message: callers get `{ code: "not_configured" }` and nothing else.
 */
export class UnlinkNotConfiguredError extends Error {
  readonly recoverable = true as const
  readonly code = 'not_configured' as const
  constructor(...missing: string[]) {
    super(
      `not_configured: the private payout seam has no credentials; no funds moved.${
        missing.length ? ` Missing: ${missing.join(', ')}.` : ''
      }`,
    )
    this.name = 'UnlinkNotConfiguredError'
  }
}

/**
 * Dynamically load the Unlink SDK, throwing {@link UnlinkSdkUnavailableError}
 * (fail-soft, no secret) when the package is absent. Always call at request time
 * inside a try/catch on the payout path — never at module top level.
 *
 * @returns The narrowed {@link UnlinkSdk} runtime surface.
 * @throws {UnlinkSdkUnavailableError} when `@unlink-xyz/sdk` cannot be resolved.
 */
export async function loadUnlinkSdk(): Promise<UnlinkSdk> {
  try {
    // Guarded dynamic import: webpack treats `@unlink-xyz/sdk` as a server
    // external (see next.config.ts), so this resolves the real package at
    // runtime when present and throws (caught here) when it is not.
    const mod = (await import('@unlink-xyz/sdk')) as unknown as UnlinkSdk
    return mod
  } catch (err) {
    throw new UnlinkSdkUnavailableError(err)
  }
}
