/**
 * blink.ts — the one-tap deposit funding seam.
 *
 * "Fund without leaving the app": a buyer/agent tops up their connected wallet
 * with USDC in one tap — no copying addresses, no switching networks — and that
 * USDC then flows into the existing pay path (CheckoutCard → payToken). This is
 * the funding LAYER that sits on top of the embedded wallet; it never settles the
 * payment itself.
 *
 * ENV-GATED + FAIL-SOFT (mirrors lib/oidc/config.ts and the Unlink loadSdk seam):
 *   - One place reads whether one-tap deposit is on (`BLINK_ENABLED`) and its
 *     public config (`NEXT_PUBLIC_BLINK_*`), so turning it on/off or repointing it
 *     is an ENV change, never a code change.
 *   - With no env set the seam reports `not_configured` and the funding button is
 *     hidden — it NEVER throws and NEVER invents an address/name (law #4).
 *   - The SDK itself is loaded OPTIONALLY at click time via `loadSdk.ts`, so a
 *     missing package fails soft (`deposit_sdk_unavailable`) instead of wedging
 *     the build (exactly like the Unlink private leg).
 *
 * GENERIC BY DESIGN: nothing here is a branded constant. The default deposit token
 * is USDC (the settlement asset); the chain id and token are env-overridable. The
 * public sponsor name "Blink"/"blink.cash" appears only as the integration target
 * in env var names + docs, never hardcoded as a value in code.
 */

import {
  DepositSdkUnavailableError,
  loadDepositSdk,
  type DepositSdk,
} from './loadSdk'

/** The default token a one-tap deposit delivers — USDC, the settlement asset. */
export const DEFAULT_DEPOSIT_TOKEN = 'USDC'

/**
 * True only when one-tap deposit is explicitly enabled via `BLINK_ENABLED`
 * (truthy: "1" / "true" / "yes", case-insensitive). Blank/unset ⇒ OFF (fail-soft).
 * A server-readable flag so the seam can be gated without exposing intent to the
 * client when off.
 */
export function isBlinkEnabled(): boolean {
  const v = (process.env.BLINK_ENABLED ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * The public client/app id the one-tap deposit widget needs to start (PUBLIC,
 * `NEXT_PUBLIC_BLINK_APP_ID`). Blank ⇒ the seam is unconfigured. There is NO
 * hardcoded default — an app id is deployment-specific and a guessed value would
 * either fail or, worse, point at the wrong account (law #4: never invent one).
 */
export function blinkAppId(): string {
  return (process.env.NEXT_PUBLIC_BLINK_APP_ID ?? '').trim()
}

/**
 * The default token the deposit delivers, env-overridable
 * (`NEXT_PUBLIC_BLINK_TOKEN`), defaulting to USDC (the asset the pay path settles
 * in). Public — the token symbol is not a secret.
 */
export function blinkToken(): string {
  const v = (process.env.NEXT_PUBLIC_BLINK_TOKEN ?? '').trim()
  return v.length > 0 ? v : DEFAULT_DEPOSIT_TOKEN
}

/**
 * The default chain id the deposit lands on. Read from `NEXT_PUBLIC_BLINK_CHAIN_ID`
 * with a fallback to the app's default settlement chain (`NEXT_PUBLIC_DEFAULT_CHAIN_ID`).
 * Returns `undefined` when neither is a positive integer — the caller then passes
 * the checkout's own chain id (it always has one), so this is a convenience
 * default, never a guess that could misroute funds.
 */
export function blinkChainId(): number | undefined {
  const raw = (
    process.env.NEXT_PUBLIC_BLINK_CHAIN_ID ??
    process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID ??
    ''
  ).trim()
  if (raw.length === 0) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * True only when one-tap deposit can actually run: it is enabled AND a public app
 * id is configured to start the widget. When false the funding button hides this
 * option and any deposit call returns `not_configured` — honest, never a faked
 * "ready" (law #4). The SDK's presence is a SEPARATE, later check (at click time)
 * so we don't probe the package on every render.
 */
export function isBlinkConfigured(): boolean {
  return isBlinkEnabled() && blinkAppId().length > 0
}

/**
 * CLIENT-SAFE configured check for a client component (CheckoutCard). The server
 * flag `BLINK_ENABLED` is NOT inlined into the browser bundle, so the client gates
 * the funding button purely on the PUBLIC app id (`NEXT_PUBLIC_BLINK_APP_ID`) — a
 * blank app id ⇒ the option is hidden. The full {@link isBlinkConfigured} (which
 * also requires `BLINK_ENABLED`) still guards the actual deposit on the server
 * side, so this only ever DECIDES VISIBILITY, never performs the money action.
 */
export function isBlinkPublicConfigured(): boolean {
  return blinkAppId().length > 0
}

/** The discriminated result of a one-tap deposit attempt. */
export type BlinkDepositResult =
  | { ok: true; status: string; txHash?: `0x${string}` }
  | { ok: false; code: 'not_configured' | 'deposit_sdk_unavailable' | 'deposit_failed'; reason: string }

/** Inputs to a one-tap deposit. `address` is the wallet to fund (the buyer/agent EOA). */
export interface BlinkDepositInput {
  /** Human deposit amount (e.g. "5.00"). */
  amount: string
  /** Destination wallet address to fund. */
  address: `0x${string}`
  /** Destination chain id; defaults to the configured/checkout chain. */
  chainId?: number
  /** Token to deposit; defaults to {@link blinkToken} (USDC). */
  token?: string
}

/**
 * Run a one-tap deposit, fully fail-soft. The SDK is injected for testability
 * (defaults to the guarded dynamic loader). Returns a discriminated result and
 * NEVER throws:
 *   - unconfigured  ⇒ `{ ok:false, code:'not_configured' }` (no SDK probe)
 *   - SDK absent    ⇒ `{ ok:false, code:'deposit_sdk_unavailable' }` (no funds moved)
 *   - SDK error     ⇒ `{ ok:false, code:'deposit_failed' }` (clean reason, no secret)
 *   - success       ⇒ `{ ok:true, status, txHash? }`
 *
 * The wallet (Dynamic `primaryWallet`) is the funding source — this seam only
 * opens the deposit; the resulting USDC sits in the buyer/agent EOA and flows into
 * the existing pay path. No address or name is ever invented (law #4).
 */
export async function runBlinkDeposit(
  input: BlinkDepositInput,
  loadSdk: () => Promise<DepositSdk> = loadDepositSdk,
): Promise<BlinkDepositResult> {
  if (!isBlinkConfigured()) {
    return {
      ok: false,
      code: 'not_configured',
      reason:
        'One-tap deposit is not configured. Set BLINK_ENABLED + NEXT_PUBLIC_BLINK_APP_ID to enable it.',
    }
  }

  const chainId = input.chainId ?? blinkChainId()
  if (chainId === undefined) {
    return {
      ok: false,
      code: 'not_configured',
      reason: 'No deposit chain id available; pass the checkout chain id or set NEXT_PUBLIC_BLINK_CHAIN_ID.',
    }
  }

  let sdk: DepositSdk
  try {
    sdk = await loadSdk()
  } catch (err) {
    if (err instanceof DepositSdkUnavailableError) {
      return { ok: false, code: 'deposit_sdk_unavailable', reason: err.message }
    }
    return {
      ok: false,
      code: 'deposit_sdk_unavailable',
      reason: 'One-tap deposit SDK could not be loaded.',
    }
  }

  try {
    const res = await sdk.requestDeposit({
      amount: input.amount,
      chainId,
      address: input.address,
      token: input.token ?? blinkToken(),
    })
    return { ok: true, status: res.status, txHash: res.txHash }
  } catch (err) {
    // Fail-soft: surface a clean reason, never a stack trace or a secret. No funds
    // moved that the caller must reconcile — the deposit either completed (above)
    // or did not start.
    const reason = err instanceof Error ? err.message : 'One-tap deposit failed.'
    return { ok: false, code: 'deposit_failed', reason }
  }
}

/**
 * A one-line, honest "configure me" note for logs / a health endpoint. Names the
 * env vars an installer sets to turn one-tap deposit on — never a vendor value.
 */
export const BLINK_CONFIGURE_NOTE =
  'Set BLINK_ENABLED=true + NEXT_PUBLIC_BLINK_APP_ID to enable one-tap deposit funding; ' +
  'override NEXT_PUBLIC_BLINK_TOKEN / NEXT_PUBLIC_BLINK_CHAIN_ID to change the deposited ' +
  'asset or destination chain. Blank ⇒ the funding option is hidden (fail-soft).'
