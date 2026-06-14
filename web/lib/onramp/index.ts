/**
 * index.ts — the provider-agnostic fiat on-ramp session builder.
 *
 * `buildOnrampSession()` returns a HOSTED-CHECKOUT URL for whichever provider env
 * selects (Coinbase Onramp / MoonPay / Stripe / Circle / one-tap deposit). The
 * on-ramp delivers USDC to the buyer/agent EOA, which then flows into the existing
 * pay path (CheckoutCard → payToken) — this seam never settles the payment.
 *
 * PURE + FAIL-SOFT (matches the unlink/oidc seam shape):
 *   - All env reads go through `config.ts`; this module is pure URL assembly.
 *   - Unconfigured ⇒ `{ ok:false, code:'not_configured' }` — NEVER a guessed URL,
 *     address, or provider (law #4). It NEVER throws.
 *   - No SECRET ever reaches the returned URL: only PUBLIC params (app id, address,
 *     amount, asset, network, redirect) are encoded. A server-only key (if a
 *     provider needs one to mint a token) stays server-side and is never logged or
 *     returned.
 *
 * GENERIC BY DESIGN: the per-provider param NAMES below are the only place a
 * provider's expected query shape lives. Adding/repointing a provider is a small,
 * isolated change here; the route, button, and pay path never change. No provider
 * endpoint is hardcoded — the base URL is always env (`NEXT_PUBLIC_ONRAMP_BASE_URL`).
 */

import {
  isOnrampConfigured,
  onrampAppId,
  onrampAsset,
  onrampBaseUrl,
  onrampNetwork,
  onrampProvider,
  type OnrampProvider,
} from './config'

/** Inputs to build a hosted on-ramp session. `address` is the wallet to fund. */
export interface OnrampSessionInput {
  /** Destination wallet address to fund (the buyer/agent EOA). REQUIRED. */
  address: `0x${string}`
  /** Fiat amount to fund, as a string (e.g. "20"). Optional — provider may prompt. */
  amount?: string
  /** Override the delivered asset (defaults to the configured asset / USDC). */
  asset?: string
  /** Override the delivery network slug (defaults to the configured network). */
  network?: string
  /** Where the provider returns the user after funding (their app's return URL). */
  redirectUrl?: string
}

/** The discriminated result of building an on-ramp session. NEVER throws. */
export type OnrampSessionResult =
  | { ok: true; provider: OnrampProvider; url: string }
  | {
      ok: false
      code: 'not_configured' | 'invalid_input'
      reason: string
    }

/** True only for a plausibly-real 0x EOA (20-byte hex). Never trust an address. */
function isHexAddress(v: string): v is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(v)
}

/**
 * The PUBLIC query-param names each provider's hosted widget expects for the
 * common fields. This is the single place provider URL shapes live; it carries NO
 * endpoint (the base is always env) and NO secret. Confirm each against the
 * provider's hosted-widget docs at the booth.
 */
const PROVIDER_PARAMS: Record<
  OnrampProvider,
  { appId: string; address: string; amount: string; asset: string; network: string; redirect: string }
> = {
  // Coinbase Onramp hosted widget params.
  coinbase: {
    appId: 'appId',
    address: 'destinationWallet',
    amount: 'presetFiatAmount',
    asset: 'defaultAsset',
    network: 'defaultNetwork',
    redirect: 'redirectUrl',
  },
  // MoonPay hosted widget params.
  moonpay: {
    appId: 'apiKey',
    address: 'walletAddress',
    amount: 'baseCurrencyAmount',
    asset: 'currencyCode',
    network: 'network',
    redirect: 'redirectURL',
  },
  // Stripe hosted onramp params.
  stripe: {
    appId: 'pk',
    address: 'destination_wallet',
    amount: 'amount',
    asset: 'destination_currency',
    network: 'destination_network',
    redirect: 'return_url',
  },
  // Circle hosted funding params.
  circle: {
    appId: 'appId',
    address: 'address',
    amount: 'amount',
    asset: 'asset',
    network: 'blockchain',
    redirect: 'redirectUrl',
  },
  // One-tap deposit provider hosted params.
  blink: {
    appId: 'appId',
    address: 'address',
    amount: 'amount',
    asset: 'token',
    network: 'chain',
    redirect: 'redirectUrl',
  },
}

/**
 * Build a hosted on-ramp checkout URL, fully fail-soft and pure.
 *
 * Returns `{ ok:false, code:'not_configured' }` when the seam is unconfigured (no
 * provider/base/app id) and `{ ok:false, code:'invalid_input' }` for a missing or
 * malformed destination address — NEVER a guessed URL or address (law #4). On
 * success returns the provider id + the PUBLIC-params-only hosted URL.
 *
 * No throw, no secret in the URL: only the public app id and the
 * caller-supplied/configured public fields are encoded. A provider that requires a
 * server-minted token can layer that in its route wiring without changing this
 * pure builder.
 */
export function buildOnrampSession(input: OnrampSessionInput): OnrampSessionResult {
  if (!isOnrampConfigured()) {
    return {
      ok: false,
      code: 'not_configured',
      reason:
        'Fiat on-ramp is not configured. Set ONRAMP_PROVIDER + NEXT_PUBLIC_ONRAMP_BASE_URL + NEXT_PUBLIC_ONRAMP_APP_ID to enable it.',
    }
  }

  const provider = onrampProvider()
  // isOnrampConfigured already guarantees a known provider; this narrows the type
  // and is a belt-and-braces guard against a config drift between the two reads.
  if (provider === undefined) {
    return { ok: false, code: 'not_configured', reason: 'No on-ramp provider selected.' }
  }

  if (typeof input.address !== 'string' || !isHexAddress(input.address)) {
    return {
      ok: false,
      code: 'invalid_input',
      reason: 'A valid 0x destination address is required to build an on-ramp session.',
    }
  }

  const base = onrampBaseUrl()
  let url: URL
  try {
    url = new URL(base)
  } catch {
    // A malformed configured base is an operator misconfig, not a guess we can
    // fix — report unconfigured rather than emit a broken/guessed URL.
    return {
      ok: false,
      code: 'not_configured',
      reason: 'NEXT_PUBLIC_ONRAMP_BASE_URL is not a valid URL.',
    }
  }

  const p = PROVIDER_PARAMS[provider]
  const asset = input.asset ?? onrampAsset()
  const network = input.network ?? onrampNetwork()

  // Only PUBLIC params — no secret ever enters the URL.
  url.searchParams.set(p.appId, onrampAppId())
  url.searchParams.set(p.address, input.address)
  url.searchParams.set(p.asset, asset)
  if (network.length > 0) url.searchParams.set(p.network, network)
  if (typeof input.amount === 'string' && input.amount.trim().length > 0) {
    url.searchParams.set(p.amount, input.amount.trim())
  }
  if (typeof input.redirectUrl === 'string' && input.redirectUrl.trim().length > 0) {
    url.searchParams.set(p.redirect, input.redirectUrl.trim())
  }

  return { ok: true, provider, url: url.toString() }
}

export {
  isOnrampConfigured,
  isOnrampPublicConfigured,
  onrampProvider,
  ONRAMP_CONFIGURE_NOTE,
  KNOWN_ONRAMP_PROVIDERS,
  type OnrampProvider,
} from './config'
