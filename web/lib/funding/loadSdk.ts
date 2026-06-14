/**
 * loadSdk.ts — the OPTIONAL/dynamic loader for the one-tap deposit SDK
 * (`@swype-org/deposit`), the funding layer that lets a buyer/agent top up their
 * wallet without copying addresses or switching networks.
 *
 * WHY THIS EXISTS (mirrors lib/unlink/loadSdk.ts)
 * ----------------------------------------------
 * The deposit SDK is a booth-installed package; off a clean `main` it is NOT
 * present. A STATIC `import { requestDeposit } from "@swype-org/deposit"` makes
 * `next build` (webpack) HARD-FAIL with "Module not found" before the booth even
 * opens, and would wedge the whole build over one optional funding leg.
 *
 * THE FIX (fail-soft, doctrine: isolate a missing dependency, never wedge the
 * whole build): load the SDK at CALL TIME via a guarded dynamic `import()` and
 * surface a clear, recoverable `not_configured`-style error when it is absent.
 * The funding button then degrades gracefully — `next build` succeeds without the
 * package, checkout/pay are untouched, and a deposit attempt without the SDK
 * returns a clean unavailable result instead of crashing module load.
 *
 * The package is declared a webpack server external in `next.config.ts` (alongside
 * `@unlink-xyz/sdk`) so webpack emits a runtime resolve (this dynamic import)
 * rather than trying to bundle a package that isn't installed.
 *
 * Vitest is unaffected: a deposit test can `vi.mock("@swype-org/deposit", …)` and
 * `vi.mock` intercepts this dynamic import exactly as it would a static one.
 *
 * NOTE: the local TYPE shim lives in `types/deposit-sdk.d.ts` so this module
 * typechecks off a clean `main` without the runtime package present.
 */

/**
 * The narrow runtime surface this app consumes from the deposit SDK: just the
 * one-tap `requestDeposit` entrypoint. Pulled from the module's own type (the
 * local shim, or the real package at the booth) so it can never drift.
 */
export type DepositSdk = Pick<typeof import('@swype-org/deposit'), 'requestDeposit'>

/**
 * Thrown when the one-tap deposit path is exercised but the SDK is not installed
 * (the pre-booth state). `recoverable` mirrors the money-path law (#5) convention:
 * NO funds moved, the operation can be retried once the package is present — the
 * caller surfaces a clean unavailable result rather than a stack trace, and NEVER
 * a secret or a guessed address (law #4).
 */
export class DepositSdkUnavailableError extends Error {
  readonly recoverable = true as const
  readonly code = 'deposit_sdk_unavailable' as const
  constructor(cause?: unknown) {
    super(
      'deposit_sdk_unavailable: @swype-org/deposit is not installed in this build ' +
        '(install it at the booth). The one-tap deposit funding leg is unavailable; no funds moved.',
    )
    this.name = 'DepositSdkUnavailableError'
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

/**
 * Dynamically load the deposit SDK, throwing {@link DepositSdkUnavailableError}
 * (fail-soft, no secret) when the package is absent. Always call at request time
 * inside a try/catch on the funding path — never at module top level.
 *
 * @returns The narrowed {@link DepositSdk} runtime surface.
 * @throws {DepositSdkUnavailableError} when `@swype-org/deposit` cannot be resolved.
 */
export async function loadDepositSdk(): Promise<DepositSdk> {
  try {
    // Guarded dynamic import: webpack treats `@swype-org/deposit` as a server
    // external (see next.config.ts), so this resolves the real package at runtime
    // when present and throws (caught here) when it is not.
    const mod = (await import('@swype-org/deposit')) as unknown as DepositSdk
    return mod
  } catch (err) {
    throw new DepositSdkUnavailableError(err)
  }
}
