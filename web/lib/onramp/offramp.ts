/**
 * offramp.ts — the provider-agnostic fiat OFF-ramp ("cash out") session builder.
 *
 * "Send money back to the bank": a buyer/agent/merchant SELLS crypto for fiat that
 * lands in their bank/card via a hosted off-ramp (MoonPay / Transak / Coinbase
 * Offramp). This is the mirror of `index.ts` (the on-ramp): the on-ramp brings
 * money IN to a wallet, this takes money OUT of one. It NEVER touches the Solidity
 * money path — it only assembles a hosted sell-widget URL.
 *
 * GENERIC + FAIL-SOFT (mirrors the on-ramp seam exactly):
 *   - Which off-ramp runs is chosen by `OFFRAMP_PROVIDER`; the hosted base URL +
 *     public app/api id come from `NEXT_PUBLIC_OFFRAMP_*`. Repointing the provider
 *     is an ENV change, never a code change. NO provider endpoint is hardcoded.
 *   - Unconfigured ⇒ `{ ok:false, code:'not_configured' }` — NEVER a guessed sell
 *     URL, address, or provider (law #4). It NEVER throws.
 *   - No SECRET ever reaches the URL: only PUBLIC params (app id, source wallet,
 *     amount, asset, network, redirect). A server-only key (if a provider needs one
 *     to mint a sell token) stays server-side and is never logged or returned.
 *   - The two-layer partner-fee % ({@link rampPartnerFeePercent}) applies to the
 *     sell exactly as it does to the buy.
 *
 * Only the providers that ACTUALLY off-ramp are listed — Stripe (on-ramp only) and
 * the one-tap deposit rail are deliberately absent; we never imply a sell flow a
 * provider does not offer.
 */

import { isAddress } from 'viem'

import { rampPartnerFeePercent } from './config'

/**
 * The off-ramp providers this seam can format a hosted SELL URL for. A subset of
 * the on-ramp set — only providers with a real cash-out flow. Selected by env, not
 * a default; an unknown/blank value ⇒ unconfigured (fail-soft).
 */
export const KNOWN_OFFRAMP_PROVIDERS = ['moonpay', 'transak', 'coinbase'] as const

export type OfframpProvider = (typeof KNOWN_OFFRAMP_PROVIDERS)[number]

/** Selected off-ramp provider from `OFFRAMP_PROVIDER`, or undefined when blank/unknown. */
export function offrampProvider(): OfframpProvider | undefined {
  const v = (process.env.OFFRAMP_PROVIDER ?? '').trim().toLowerCase()
  return (KNOWN_OFFRAMP_PROVIDERS as readonly string[]).includes(v)
    ? (v as OfframpProvider)
    : undefined
}

/** Hosted off-ramp base URL (`NEXT_PUBLIC_OFFRAMP_BASE_URL`); blank ⇒ unconfigured. */
export function offrampBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_OFFRAMP_BASE_URL ?? '').trim()
}

/** PUBLIC app/api id the hosted off-ramp identifies by (`NEXT_PUBLIC_OFFRAMP_APP_ID`). */
export function offrampAppId(): string {
  return (process.env.NEXT_PUBLIC_OFFRAMP_APP_ID ?? '').trim()
}

/** The crypto asset being sold (`NEXT_PUBLIC_OFFRAMP_ASSET`), defaulting to USDC. PUBLIC. */
export function offrampAsset(): string {
  const v = (process.env.NEXT_PUBLIC_OFFRAMP_ASSET ?? '').trim()
  return v.length > 0 ? v : 'USDC'
}

/** The network the crypto is sold FROM (`NEXT_PUBLIC_OFFRAMP_NETWORK`), provider slug. PUBLIC. */
export function offrampNetwork(): string {
  return (process.env.NEXT_PUBLIC_OFFRAMP_NETWORK ?? '').trim()
}

/** OPTIONAL server-only key for providers that mint a sell token (`OFFRAMP_SERVER_KEY`). SERVER-ONLY. */
export function offrampServerKey(): string {
  return (process.env.OFFRAMP_SERVER_KEY ?? '').trim()
}

/** True only when the off-ramp can build a hosted sell URL: provider + base + app id all set. */
export function isOfframpConfigured(): boolean {
  return offrampProvider() !== undefined && offrampBaseUrl().length > 0 && offrampAppId().length > 0
}

/** CLIENT-SAFE visibility check (the provider select is server-only): public base + app id. */
export function isOfframpPublicConfigured(): boolean {
  return offrampBaseUrl().length > 0 && offrampAppId().length > 0
}

/** A one-line, honest "configure me" note naming the off-ramp env vars + valid providers. */
export const OFFRAMP_CONFIGURE_NOTE =
  'Set OFFRAMP_PROVIDER (one of: ' +
  KNOWN_OFFRAMP_PROVIDERS.join(', ') +
  ') + NEXT_PUBLIC_OFFRAMP_BASE_URL + NEXT_PUBLIC_OFFRAMP_APP_ID to enable cashing out; ' +
  'optionally NEXT_PUBLIC_OFFRAMP_ASSET / NEXT_PUBLIC_OFFRAMP_NETWORK and a server-only ' +
  'OFFRAMP_SERVER_KEY. Blank ⇒ the cash-out option is hidden (fail-soft).'

/**
 * The PUBLIC query-param names each provider's hosted SELL widget expects. Single
 * place the sell-URL shapes live; carries NO endpoint (base is env) and NO secret.
 * Confirm each against the provider's off-ramp docs at the booth — sell params
 * differ from buy params (e.g. the amount is a CRYPTO amount, not fiat).
 */
const OFFRAMP_PROVIDER_PARAMS: Record<
  OfframpProvider,
  { appId: string; address: string; amount: string; asset: string; network: string; redirect: string }
> = {
  // MoonPay Sell widget params.
  moonpay: {
    appId: 'apiKey',
    address: 'walletAddress',
    amount: 'baseCurrencyAmount',
    asset: 'baseCurrencyCode',
    network: 'network',
    redirect: 'redirectURL',
  },
  // Transak (productsAvailed=SELL) widget params.
  transak: {
    appId: 'apiKey',
    address: 'walletAddress',
    amount: 'cryptoAmount',
    asset: 'cryptoCurrencyCode',
    network: 'network',
    redirect: 'redirectURL',
  },
  // Coinbase Offramp hosted params.
  coinbase: {
    appId: 'appId',
    address: 'address',
    amount: 'presetCryptoAmount',
    asset: 'asset',
    network: 'network',
    redirect: 'redirectUrl',
  },
}

/** Inputs to build a hosted off-ramp session. `address` is the wallet to sell FROM. */
export interface OfframpSessionInput {
  /** Source wallet the crypto is sold FROM (the buyer/agent/merchant EOA). REQUIRED. */
  address: `0x${string}`
  /** CRYPTO amount to sell, as a string (e.g. "20"). Optional — provider may prompt. */
  amount?: string
  /** Override the sold asset (defaults to the configured asset / USDC). */
  asset?: string
  /** Override the source network slug (defaults to the configured network). */
  network?: string
  /** Where the provider returns the user after the sell completes. */
  redirectUrl?: string
}

/** The discriminated result of building an off-ramp session. NEVER throws. */
export type OfframpSessionResult =
  | {
      ok: true
      provider: OfframpProvider
      url: string
      /** The two-layer partner-fee % to apply to this cash-out (same knob as the on-ramp). */
      partnerFeePercent: number
    }
  | {
      ok: false
      code: 'not_configured' | 'invalid_input'
      reason: string
    }

/**
 * Build a hosted off-ramp ("cash out to bank") URL, fully fail-soft and pure.
 *
 * Returns `not_configured` when the seam is unconfigured (no provider/base/app id)
 * and `invalid_input` for a missing/malformed source address — NEVER a guessed URL
 * or address (law #4). On success returns the provider id + the PUBLIC-params-only
 * hosted sell URL + the partner-fee %. No throw, no secret in the URL.
 */
export function buildOfframpSession(input: OfframpSessionInput): OfframpSessionResult {
  if (!isOfframpConfigured()) {
    return {
      ok: false,
      code: 'not_configured',
      reason:
        'Fiat off-ramp is not configured. Set OFFRAMP_PROVIDER + NEXT_PUBLIC_OFFRAMP_BASE_URL + NEXT_PUBLIC_OFFRAMP_APP_ID to enable it.',
    }
  }

  const provider = offrampProvider()
  // isOfframpConfigured already guarantees a known provider; narrow the type + guard config drift.
  if (provider === undefined) {
    return { ok: false, code: 'not_configured', reason: 'No off-ramp provider selected.' }
  }

  if (typeof input.address !== 'string' || !isAddress(input.address)) {
    return {
      ok: false,
      code: 'invalid_input',
      reason: 'A valid 0x source address is required to build an off-ramp session.',
    }
  }

  const base = offrampBaseUrl()
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return {
      ok: false,
      code: 'not_configured',
      reason: 'NEXT_PUBLIC_OFFRAMP_BASE_URL is not a valid URL.',
    }
  }

  const p = OFFRAMP_PROVIDER_PARAMS[provider]
  const asset = input.asset ?? offrampAsset()
  const network = input.network ?? offrampNetwork()

  // Only PUBLIC params — no secret ever enters the URL.
  url.searchParams.set(p.appId, offrampAppId())
  url.searchParams.set(p.address, input.address)
  url.searchParams.set(p.asset, asset)
  if (network.length > 0) url.searchParams.set(p.network, network)
  if (typeof input.amount === 'string' && input.amount.trim().length > 0) {
    url.searchParams.set(p.amount, input.amount.trim())
  }
  if (typeof input.redirectUrl === 'string' && input.redirectUrl.trim().length > 0) {
    url.searchParams.set(p.redirect, input.redirectUrl.trim())
  }

  return { ok: true, provider, url: url.toString(), partnerFeePercent: rampPartnerFeePercent() }
}
