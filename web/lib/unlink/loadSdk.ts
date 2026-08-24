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

/** The four bindings this app consumes. A composed load needs all four. */
const REQUIRED_BINDINGS = [
  'account',
  'buildDeriveSeedMessage',
  'createUnlinkAdmin',
  'createUnlinkClient',
] as const

/**
 * The documented SUBPATHS, searched only when the root specifier does not
 * resolve at all — paired with a LITERAL dynamic import each.
 *
 * WHY A FALLBACK IS NEEDED. The published package's current canary `exports` map
 * has NO root `.` entry — only `./admin`, `./react`, `./client`, `./crypto`,
 * `./browser` and `./advanced`. Against that build a bare
 * `import('@unlink-xyz/sdk')` fails to resolve, the catch converts it into
 * `UnlinkSdkUnavailableError`, and every caller falls back to the public rail —
 * so INSTALLING the package would be indistinguishable from not installing it.
 * Searching the subpaths is what makes an install actually take effect.
 *
 * WHY LITERALS, NOT A COMPUTED SPECIFIER. `import(someVariable)` makes webpack
 * emit a context module and warn "the request of a dependency is an expression",
 * defeating the `commonjs` externals declared for these exact specifiers in
 * `next.config.ts`. A literal per entry keeps each one statically analysable and
 * therefore a clean runtime require.
 *
 * Placement, per the vendor docs: `account.fromEthereumSignature` and
 * `buildDeriveSeedMessage` under `/crypto`, `createUnlinkAdmin` under `/admin`.
 * The home of `createUnlinkClient` is UNCONFIRMED — `/client` is the obvious
 * candidate from the exports map, not a documented fact. That uncertainty is why
 * the loader does not hardcode a binding-to-subpath map: each binding is taken
 * from the first reachable module that exports it, so a wrong guess costs nothing
 * and a relocated binding is still found.
 */
const UNLINK_SUBPATH_LOADERS: ReadonlyArray<() => Promise<unknown>> = [
  () => import('@unlink-xyz/sdk/crypto'),
  () => import('@unlink-xyz/sdk/admin'),
  () => import('@unlink-xyz/sdk/client'),
]

/** True once every required binding has been collected. */
function isComplete(found: Partial<UnlinkSdk>): found is UnlinkSdk {
  return REQUIRED_BINDINGS.every((k) => found[k] !== undefined)
}

/**
 * Read one named export without assuming it exists. A module namespace may throw
 * on an unknown property (vitest's mock proxy does exactly that), so a probe must
 * never let a missing binding become an exception.
 */
function readBinding(mod: object, key: string): unknown {
  try {
    return (mod as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * Dynamically load the Unlink SDK, throwing {@link UnlinkSdkUnavailableError}
 * (fail-soft, no secret) when it cannot be resolved. Always call at request time
 * inside a try/catch on the payout path — never at module top level.
 *
 * Resolution order:
 *   1. The in-repo FAKE shielded set, when a developer explicitly opted in
 *      (`UNLINK_FAKE_SDK=true`, refused in production). See `fakeSdk.ts` — it
 *      moves no money and returns tx hashes marked as synthetic.
 *   2. The ROOT specifier. When it resolves, its namespace IS the SDK, exactly as
 *      before — the local type shim declares a root module and the package's
 *      older `latest` dist-tag still publishes one.
 *   3. Only when the root does not resolve: compose the four bindings from the
 *      documented subpaths. A partial composition is treated as NO load, because
 *      half a surface would fail later, deep inside a money path, instead of here
 *      where nothing has moved yet.
 *
 * @returns The narrowed {@link UnlinkSdk} runtime surface.
 * @throws {UnlinkSdkUnavailableError} when neither the root nor the subpaths yield
 *         a usable surface.
 */
export async function loadUnlinkSdk(): Promise<UnlinkSdk> {
  const fake = await loadFakeIfEnabled()
  if (fake) return fake

  try {
    // Guarded dynamic import: webpack treats the specifier as a server external
    // (see next.config.ts), so this resolves the real package at runtime when
    // present and throws (caught here) when it is not.
    return (await import('@unlink-xyz/sdk')) as unknown as UnlinkSdk
  } catch (rootError) {
    return composeFromSubpaths(rootError)
  }
}

/**
 * Build the SDK surface from the documented subpaths, taking each binding from
 * the first module that exports it.
 *
 * @param rootError - why the root specifier failed, carried as the cause so a log
 *                    shows the original resolution error rather than a subpath's.
 * @throws {UnlinkSdkUnavailableError} when the four bindings are not all found.
 */
async function composeFromSubpaths(rootError: unknown): Promise<UnlinkSdk> {
  const found: Partial<UnlinkSdk> = {}

  for (const loadSubpath of UNLINK_SUBPATH_LOADERS) {
    let mod: object
    try {
      mod = (await loadSubpath()) as object
    } catch {
      // A missing subpath is expected on any given package version — keep going.
      continue
    }
    for (const key of REQUIRED_BINDINGS) {
      if (found[key] !== undefined) continue
      const binding = readBinding(mod, key)
      if (binding !== undefined) {
        ;(found as Record<string, unknown>)[key] = binding
      }
    }
    if (isComplete(found)) return found
  }

  throw new UnlinkSdkUnavailableError(rootError)
}

/**
 * Load the in-repo fake shielded set when — and only when — a developer asked
 * for it. Returns null in every other case, including production, so the normal
 * path never even imports the module.
 */
async function loadFakeIfEnabled(): Promise<UnlinkSdk | null> {
  const { fakeSdkEnabled } = await import('./fakeSdkFlag.js')
  if (!fakeSdkEnabled()) return null
  const { createFakeUnlinkSdk } = await import('./fakeSdk.js')
  return createFakeUnlinkSdk()
}
