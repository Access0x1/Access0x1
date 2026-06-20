/**
 * config.ts — the PROVIDER-AGNOSTIC fiat on-ramp env seam.
 *
 * "Bring money from a bank": a buyer/agent funds their wallet with USDC via a
 * hosted fiat on-ramp (card / bank / Apple Pay, whatever the provider supports),
 * delivered to their EOA, which then flows into the existing pay path.
 *
 * GENERIC BY DESIGN (mirrors lib/oidc/config.ts): NO provider is hardcoded in
 * code. Which on-ramp runs — Coinbase Onramp, MoonPay, Stripe, Circle, or a
 * one-tap deposit provider — is chosen by `ONRAMP_PROVIDER`, and the hosted base
 * URL + public app/api key come from `NEXT_PUBLIC_ONRAMP_*`. Pointing the seam at
 * a different provider is an ENV change, never a code change. The public sponsor
 * names appear only as the documented set of valid `ONRAMP_PROVIDER` values, never
 * as a baked-in default endpoint.
 *
 * FAIL-SOFT + HONEST (law #4): with no provider/base configured the seam is
 * UNCONFIGURED — `buildOnrampSession()` returns `not_configured` and the route
 * answers 503, rather than inventing a checkout URL. No address, key, or provider
 * endpoint is ever guessed.
 */

/**
 * The set of on-ramp providers this seam knows how to format a hosted-checkout
 * URL for. These are PUBLIC integration-target names, selected by env — not a
 * default. An unknown/blank value ⇒ the seam is unconfigured (fail-soft).
 */
export const KNOWN_ONRAMP_PROVIDERS = [
  'coinbase',
  'moonpay',
  'stripe',
  'circle',
  'blink',
  'transak',
] as const

export type OnrampProvider = (typeof KNOWN_ONRAMP_PROVIDERS)[number]

/**
 * The selected provider id from `ONRAMP_PROVIDER` (lower-cased, trimmed), or
 * `undefined` when blank/unknown. There is NO default provider on purpose: a fiat
 * on-ramp moves real money, so the operator must name one explicitly. An unknown
 * value returns `undefined` (treated as unconfigured) rather than guessing.
 */
export function onrampProvider(): OnrampProvider | undefined {
  const v = (process.env.ONRAMP_PROVIDER ?? '').trim().toLowerCase()
  return (KNOWN_ONRAMP_PROVIDERS as readonly string[]).includes(v)
    ? (v as OnrampProvider)
    : undefined
}

/**
 * The hosted on-ramp base URL the redirect is built from
 * (`NEXT_PUBLIC_ONRAMP_BASE_URL`), e.g. the provider's widget/checkout origin.
 * PUBLIC. Blank ⇒ unconfigured. NO hardcoded default endpoint — the base belongs
 * to whichever provider env selects and must be set per deployment so we never
 * point a money flow at a guessed host.
 */
export function onrampBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_ONRAMP_BASE_URL ?? '').trim()
}

/**
 * The PUBLIC app/api id the hosted on-ramp identifies the integration by
 * (`NEXT_PUBLIC_ONRAMP_APP_ID`). PUBLIC — it goes in the redirect URL. Blank ⇒
 * unconfigured. (Any SERVER secret a provider needs to MINT a session token is
 * read separately and never placed in the client-facing URL — see
 * `onrampServerKey`.)
 */
export function onrampAppId(): string {
  return (process.env.NEXT_PUBLIC_ONRAMP_APP_ID ?? '').trim()
}

/**
 * The default asset the on-ramp delivers (`NEXT_PUBLIC_ONRAMP_ASSET`), defaulting
 * to USDC — the asset the pay path settles in. PUBLIC.
 */
export function onrampAsset(): string {
  const v = (process.env.NEXT_PUBLIC_ONRAMP_ASSET ?? '').trim()
  return v.length > 0 ? v : 'USDC'
}

/**
 * The default network/chain the on-ramp delivers onto (`NEXT_PUBLIC_ONRAMP_NETWORK`),
 * a provider-specific network slug (e.g. "base", "ethereum"). PUBLIC. Blank ⇒ the
 * caller may pass one per session; we never guess a network for a money delivery.
 */
export function onrampNetwork(): string {
  return (process.env.NEXT_PUBLIC_ONRAMP_NETWORK ?? '').trim()
}

/**
 * OPTIONAL server-only key some providers require to mint a one-time session token
 * before redirect (`ONRAMP_SERVER_KEY`). SERVER-ONLY: never NEXT_PUBLIC_, never
 * placed in a response body or the redirect URL (secrets law). Blank ⇒ the seam
 * builds a plain parameterised redirect (the common hosted-widget pattern); a
 * provider that strictly requires a minted token will report not_configured for
 * that leg rather than leaking or faking a token.
 */
export function onrampServerKey(): string {
  return (process.env.ONRAMP_SERVER_KEY ?? '').trim()
}

/**
 * True only when the on-ramp can actually build a hosted-checkout URL: a known
 * provider IS selected AND a hosted base URL AND a public app id are configured.
 * When false the funding button hides the bank option and the route answers
 * `not_configured` (503) — honest, never a faked session (law #4).
 */
export function isOnrampConfigured(): boolean {
  return onrampProvider() !== undefined && onrampBaseUrl().length > 0 && onrampAppId().length > 0
}

/**
 * CLIENT-SAFE configured check for a client component (CheckoutCard). The provider
 * select `ONRAMP_PROVIDER` is server-only and NOT inlined into the browser bundle,
 * so the client gates the bank-funding button on the PUBLIC base URL + app id
 * (`NEXT_PUBLIC_ONRAMP_*`) only — both blank ⇒ the option is hidden. The full
 * {@link isOnrampConfigured} (which also requires a known provider) still guards
 * the route that BUILDS the session, so this only DECIDES VISIBILITY.
 */
export function isOnrampPublicConfigured(): boolean {
  return onrampBaseUrl().length > 0 && onrampAppId().length > 0
}

/**
 * The DEFAULT ramp partner-fee percentage the OPEN protocol ships — the "Access0x1
 * sets the percentage" baseline. It is `0`: the public, open-source SDK imposes NO
 * fee of its own (a hidden fee baked into shared code would be a footgun for every
 * integrator that drops the SDK in). A specific DEPLOYMENT sets its OWN cut via
 * `NEXT_PUBLIC_RAMP_PARTNER_FEE_PERCENT` — that is the "then the app sets it"
 * layer. The fee is collected by whichever ramp the deployment's API key
 * belongs to (configured in that provider's partner dashboard, and passed to the
 * provider's session where it accepts one); open-source cannot route a third
 * party's ramp fee to us, so this value is a single source of truth + a
 * recommendation, NOT an on-chain charge. The protocol's OWN enforced fee lives
 * on-chain as the router's `platformFeeBps` — a different surface from this
 * off-chain ramp margin.
 */
export const RAMP_DEFAULT_PARTNER_FEE_PERCENT = 0

/**
 * The partner-fee percentage for THIS deployment: `NEXT_PUBLIC_RAMP_PARTNER_FEE_PERCENT`
 * parsed as a finite number in [0, 100], else the protocol default. PUBLIC (it may
 * accompany a provider session). Two layers, one knob: the constant is the
 * Access0x1 default ("access sets it"), the env is the app's override ("the app
 * sets it"). A blank, malformed, or out-of-range value falls back to the default
 * rather than charging a guessed rate (law #4 — never invent a money number).
 */
export function rampPartnerFeePercent(): number {
  const raw = (process.env.NEXT_PUBLIC_RAMP_PARTNER_FEE_PERCENT ?? '').trim()
  if (raw.length === 0) return RAMP_DEFAULT_PARTNER_FEE_PERCENT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : RAMP_DEFAULT_PARTNER_FEE_PERCENT
}

/**
 * A one-line, honest "configure me" note for logs / a health endpoint. Names the
 * env vars an installer sets to turn the fiat on-ramp on — and the set of valid
 * providers — never baking one in.
 */
export const ONRAMP_CONFIGURE_NOTE =
  'Set ONRAMP_PROVIDER (one of: ' +
  KNOWN_ONRAMP_PROVIDERS.join(', ') +
  ') + NEXT_PUBLIC_ONRAMP_BASE_URL + NEXT_PUBLIC_ONRAMP_APP_ID to enable the fiat ' +
  'on-ramp; optionally NEXT_PUBLIC_ONRAMP_ASSET / NEXT_PUBLIC_ONRAMP_NETWORK and a ' +
  'server-only ONRAMP_SERVER_KEY. Blank ⇒ the bank-funding option is hidden (fail-soft).'
