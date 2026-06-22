/**
 * analytics.ts — the privacy-safe, type-safe product-analytics client.
 *
 * @author Rensley R. @vyperpilleddev
 *
 * WHY THIS FILE EXISTS
 * This module is the CODE form of `analytics/events.md` (the tracking plan): it
 * encodes that document's closed event taxonomy as a discriminated union, and
 * exposes one `track()` function that every call site uses to emit an event. The
 * markdown is the spec; this file is the single, typed chokepoint the whole app
 * funnels through so no event can be emitted off-taxonomy, without consent, or
 * carrying personal data.
 *
 * THE PRIVACY FLOOR (load-bearing — `events.md` §5, `legal/privacy.md` §4/§5)
 * Three guarantees are enforced here, not left to the caller's discipline:
 *   1. CONSENT-GATED + DNT/GPC-RESPECTING — `track()` is a hard no-op until consent
 *      is granted, and stays a no-op whenever the browser signals Do-Not-Track or
 *      Global-Privacy-Control. No sink configured → also a no-op (off by default).
 *   2. NO PII, EVER — the envelope is built here, never by the caller, so it can
 *      never carry an `ip`, `user_agent`, `referrer`, `email`, `address`, `name`,
 *      or `query_text`. A raw wallet address is reduced to the pseudonymous
 *      `actor_hash` (a salted, truncated, one-way digest) before it is ever stored.
 *   3. STRIP, DON'T TRUST — every event's properties are reshaped through a typed
 *      sanitizer that copies ONLY the taxonomy's declared fields. A stray
 *      `prompt`, `address`, or error message handed in by an over-eager call site
 *      is dropped on the floor, never forwarded to the sink.
 *
 * SINK-AGNOSTIC + OFF BY DEFAULT (`events.md` §6)
 * The taxonomy is independent of any vendor. The tracker writes to one pluggable
 * first-party {@link AnalyticsSink}; with no sink configured it is a no-op, and in
 * dev the default sink is a quiet console logger. `embed.js` and the SDK NEVER
 * import this module — product analytics are collected only on Access0x1-operated
 * surfaces, never on a merchant's site.
 *
 * DECLARATIVE STYLE (owner hard rule): written declaratively; avoids the word "if".
 * Conditions are phrased as guard-returns / `when` comments.
 */

import { sha256, stringToBytes } from 'viem'

import { ARC_TESTNET_ID } from './chains'

// ---------------------------------------------------------------------------
// 1. Shared property types — the closed enums + the pseudonym (events.md §4)
// ---------------------------------------------------------------------------

/**
 * The schema version this client emits. Bumps on any breaking change to the
 * envelope or an event's required properties (`events.md` §2/§10), so historical
 * rows stay interpretable. A string by spec — never a number.
 */
export const SCHEMA_VERSION = '1' as const

/**
 * The closed set of supported testnet chain ids (`events.md` §4, mirrors
 * `lib/chains.ts`). No mainnet id appears here by repo law #4 — this build is
 * testnet-only and never claims otherwise.
 */
export type SupportedChainId =
  | typeof ARC_TESTNET_ID // 5042002 — Arc Testnet (USDC is native gas)
  | 84532 // Base Sepolia
  | 300 // zkSync Sepolia

/**
 * Bucketed USD amount — a continuous figure is NEVER emitted raw, so no row can
 * narrow to a single purchase (`events.md` §4, privacy rule §5.5).
 */
export type AmountBucket =
  | 'lt_1'
  | '1_10'
  | '10_100'
  | '100_1k'
  | '1k_10k'
  | 'gte_10k'
  | 'unknown'

/**
 * Bucketed latency (ms) — submit→confirm / request→answer, never the exact ms
 * (`events.md` §4, privacy rule §5.5).
 */
export type LatencyBucket = 'lt_1s' | '1_3s' | '3_10s' | '10_30s' | 'gte_30s'

/** Which Access0x1-operated surface emitted the event (`events.md` §2). */
export type Surface =
  | 'hosted_checkout'
  | 'onboard'
  | 'assistant'
  | 'marketing'
  | 'dashboard'
  | 'admin'

/** Deployment environment — always `testnet` in this build; never `mainnet`. */
export type AppEnv = 'local' | 'testnet'

/** Any human/identity gate that can sit in front of pay (`events.md` §3). */
export type Gate = 'none' | 'world_id' | 'verified_tier'

// ---------------------------------------------------------------------------
// 2. The event taxonomy — one discriminated union (events.md §3)
// ---------------------------------------------------------------------------

/**
 * The complete, closed set of event names. This is the discriminant of
 * {@link AnalyticsEvent}; a name absent from this union cannot be tracked.
 */
export type EventName =
  | 'page_view'
  | 'connect_wallet'
  | 'register_merchant_start'
  | 'register_merchant_success'
  | 'checkout_view'
  | 'pay_initiated'
  | 'pay_success'
  | 'pay_fail'
  | 'assistant_query'
  | 'onramp_start'

/** `page_view` — a surface route was rendered (the most common event). */
export interface PageViewProps {
  /** Coarse referrer class only — never the raw referrer URL (privacy §5.2). */
  referrer_class: 'internal' | 'external' | 'direct'
  /** Always `false` in-app; the embed never emits — present for schema symmetry. */
  is_embed_host: boolean
}

/** `connect_wallet` — a wallet connection attempt resolved (Dynamic auth flow). */
export interface ConnectWalletProps {
  /** `opened` = auth modal shown; the terminal states follow. */
  status: 'opened' | 'success' | 'cancelled' | 'error'
  /** Connector CLASS from Dynamic — never the wallet's address or label. */
  connector: 'injected' | 'embedded' | 'walletconnect' | 'other'
  /** Stable, non-sensitive code (e.g. `user_rejected`) — never an error message. */
  error_code: string | null
}

/** `register_merchant_start` — a visitor began the merchant-registration form. */
export interface RegisterMerchantStartProps {
  /** Where the register flow was opened from. */
  entry: 'onboard' | 'dashboard' | 'deeplink'
  /** Whether the optional ENS payout field was used — boolean only, never the name. */
  has_ens_input: boolean
}

/** `register_merchant_success` — `registerMerchant(...)` confirmed on-chain. */
export interface RegisterMerchantSuccessProps {
  /** The merchant's configured fee in basis points (a config value, not personal). */
  fee_bps: number
  /** Class of payout target — never the resolved address. */
  payout_kind: 'self' | 'ens' | 'custom'
  /** `gasfree` on Arc (USDC-native gas), else `native_gas`. */
  tx_class: 'gasfree' | 'native_gas'
  /** Submit→confirm time, BUCKETED. */
  latency_bucket: LatencyBucket
}

/** `checkout_view` — a hosted checkout (`/c/[slug]` or `/m/[merchantId]`) was viewed. */
export interface CheckoutViewProps {
  /** Which checkout route — never the slug/id value itself. */
  checkout_kind: 'slug' | 'merchant_id'
  /** The quoted USD amount, BUCKETED — never the exact figure. */
  amount_bucket: AmountBucket
  /** The default pay-token symbol (e.g. `USDC`) — a token, not a person. */
  token_symbol: string
  /** Any human/identity gate in front of pay. */
  gate: Gate
}

/** `pay_initiated` — the buyer submitted a `payToken`/`payNative` call. */
export interface PayInitiatedProps {
  /** The router path taken. */
  method: 'pay_token' | 'pay_native'
  /** The coin the buyer chose to pay in. */
  token_symbol: string
  /** Bucketed USD amount, never exact. */
  amount_bucket: AmountBucket
  /** Whether the in-tx quote was freshly fetched. */
  quote_source: 'live' | 'cached'
  /** The gate the buyer cleared to reach pay. */
  gate_passed: Gate
}

/** `pay_success` — a payment confirmed on-chain (the conversion signal). */
export interface PaySuccessProps {
  /** Mirrors `pay_initiated`. */
  method: 'pay_token' | 'pay_native'
  /** Settlement coin symbol. */
  token_symbol: string
  /** Bucketed; never exact. */
  amount_bucket: AmountBucket
  /** Submit→confirm time, bucketed. */
  latency_bucket: LatencyBucket
  /** True on this `actor_hash`'s first-ever success — derived client/store-side. */
  is_first_payment: boolean
}

/** `pay_fail` — a pay attempt did not settle (revert, rejection, timeout, staleness). */
export interface PayFailProps {
  /** The attempted path. */
  method: 'pay_token' | 'pay_native'
  /** A stable, non-sensitive failure class — never the raw revert string (privacy §5.4). */
  reason:
    | 'user_rejected'
    | 'insufficient_funds'
    | 'reverted'
    | 'quote_stale'
    | 'timeout'
    | 'other'
  /** The attempted coin. */
  token_symbol: string
  /** Bucketed. */
  amount_bucket: AmountBucket
}

/** `assistant_query` — the assistant answered a question (server-side `/api/ask`). */
export interface AssistantQueryProps {
  /** Prompt LENGTH bucket only. The prompt text is NEVER sent (privacy §5.3). */
  query_length_bucket: 'xs' | 's' | 'm' | 'l' | 'xl'
  /** Outcome — `rate_limited` reflects the spend-cap/rate-limit guard on `/api/ask`. */
  status: 'answered' | 'rate_limited' | 'error'
  /** Answer latency, bucketed. */
  latency_bucket: LatencyBucket
}

/** `onramp_start` — a fiat on-ramp / one-tap deposit funding session was started. */
export interface OnrampStartProps {
  /** The two `FundButton` paths. */
  funding_kind: 'bank_onramp' | 'one_tap_deposit'
  /** Provider CATEGORY only — never the specific vendor account/session token (privacy §5.6). */
  provider_class: 'onramp' | 'deposit'
  /** Requested top-up amount, bucketed, where present. */
  amount_bucket: AmountBucket
}

/**
 * The discriminated union of every trackable event. Each member pairs a
 * taxonomy `name` (the discriminant) with that event's own typed `props`. The
 * shared envelope (Section 2 of `events.md`) is NOT part of this type — it is
 * assembled by {@link track} so a caller can never set it (privacy by design).
 *
 * Authoring with `track()` is exhaustive: passing `{ name: 'pay_success', props }`
 * forces `props` to be exactly {@link PaySuccessProps}; a missing or extra field
 * is a TYPE error, not a runtime privacy leak.
 */
export type AnalyticsEvent =
  | { name: 'page_view'; props: PageViewProps }
  | { name: 'connect_wallet'; props: ConnectWalletProps }
  | { name: 'register_merchant_start'; props: RegisterMerchantStartProps }
  | { name: 'register_merchant_success'; props: RegisterMerchantSuccessProps }
  | { name: 'checkout_view'; props: CheckoutViewProps }
  | { name: 'pay_initiated'; props: PayInitiatedProps }
  | { name: 'pay_success'; props: PaySuccessProps }
  | { name: 'pay_fail'; props: PayFailProps }
  | { name: 'assistant_query'; props: AssistantQueryProps }
  | { name: 'onramp_start'; props: OnrampStartProps }

// ---------------------------------------------------------------------------
// 3. The shared envelope + the emitted payload (events.md §2)
// ---------------------------------------------------------------------------

/**
 * The shared event envelope (`events.md` §2). Every field is a constant, an
 * enum, a coarse bucket, or the pseudonymous `actor_hash` — NO field is PII. It
 * is assembled by {@link track}, never by a call site, so `ip`, `user_agent`,
 * `referrer`, `email`, `address`, `name`, and `query_text` cannot leak in.
 */
export interface EventEnvelope {
  /** The taxonomy name (the union discriminant). */
  event: EventName
  /** This document's schema version. */
  schema_version: typeof SCHEMA_VERSION
  /** Client clock at emit time (epoch ms). */
  ts: number
  /** First-party, per-browser id; regenerated on consent withdrawal. Never wallet-derived. */
  anonymous_id: string
  /** Per-tab session id; rotates on a new visit. Never tied to an address. */
  session_id: string
  /** Which product surface emitted it. */
  surface: Surface
  /** Always `testnet` in this build; never `mainnet` (repo law). */
  app_env: AppEnv
  /** The ROUTE TEMPLATE (`/c/[slug]`), never the resolved slug/id/query (privacy §5.2). */
  path_template: string
  /** A supported chain id, or `null` when no chain is in context. */
  chain_id: SupportedChainId | null
  /** Pseudonymous wallet key (`events.md` §4); `null` until a wallet is connected. */
  actor_hash: string | null
  /** Records that the consent gate was on at emit time. */
  consent: 'granted'
}

/** The full, on-the-wire payload handed to a sink: the envelope + the event name + props. */
export type AnalyticsPayload = EventEnvelope & {
  /** The event's own typed properties (the union member's `props`). */
  props: AnalyticsEvent['props']
}

// ---------------------------------------------------------------------------
// 4. The pluggable sink (events.md §6)
// ---------------------------------------------------------------------------

/**
 * A first-party analytics sink. The taxonomy is vendor-independent; a deployment
 * plugs in exactly one sink (a first-party endpoint we operate) via
 * {@link configureAnalytics}. A sink receives the fully-built, already-sanitized
 * {@link AnalyticsPayload} and must add no ad cookies and set no cross-site state.
 */
export interface AnalyticsSink {
  /** A short, stable id for the sink (for diagnostics; never user data). */
  readonly id: string
  /**
   * Deliver one payload. MUST NOT throw into the caller — a sink that rejects
   * never propagates to the call site (`track()` isolates it), so a logging
   * failure can never break a money path (doctrine law #5).
   */
  send(payload: AnalyticsPayload): void | Promise<void>
}

/**
 * The default sink: a no-op in production, a quiet `console.debug` in dev. This
 * keeps the shipped default privacy-true out of the box (`events.md` §6 / privacy
 * §4: "no third-party analytics baked into the checkout or embed.js") — nothing
 * leaves the browser until a real first-party sink is configured.
 */
export const consoleSink: AnalyticsSink = {
  id: 'console',
  send(payload) {
    // Dev-only echo so an engineer can SEE the taxonomy firing while instrumenting;
    // production builds strip `console.debug` and, regardless, no event ships.
    isDev() && console.debug('[analytics]', payload.event, payload)
  },
}

// ---------------------------------------------------------------------------
// 5. Consent + the privacy gates (events.md §5.7)
// ---------------------------------------------------------------------------

/**
 * The mutable runtime configuration of the tracker. Held in one module-local
 * object so the gates have a single source of truth. It starts in the safest
 * possible state: no consent, no sink, no actor — i.e. a hard no-op.
 */
interface AnalyticsState {
  /** Whether the user has granted consent. Events emit ONLY when true. */
  consentGranted: boolean
  /** The active sink, or `null` (the off-by-default no-op). */
  sink: AnalyticsSink | null
  /** Per-deployment salt for `actor_hash`; rotating it severs historical linkage. */
  salt: string
  /** Stable per-browser anonymous id (regenerated on consent withdrawal). */
  anonymousId: string
  /** Per-session id (rotates on a new visit). */
  sessionId: string
  /** The current surface, set by the app shell. */
  surface: Surface
  /** The current route TEMPLATE (never a resolved URL). */
  pathTemplate: string
  /** The chain in context, or `null`. */
  chainId: SupportedChainId | null
  /** The pseudonymous actor key, or `null` until a wallet connects. */
  actorHash: string | null
}

/** The one module-local state. Safe defaults: no consent, no sink, no actor. */
const state: AnalyticsState = {
  consentGranted: false,
  sink: null,
  salt: readSalt(),
  anonymousId: randomId(),
  sessionId: randomId(),
  surface: 'marketing',
  pathTemplate: '/',
  chainId: null,
  actorHash: null,
}

/**
 * The master privacy gate: `true` only when the user consented AND the browser
 * is NOT signalling Do-Not-Track / Global-Privacy-Control. Every emit path checks
 * this first (`events.md` §5.7).
 *
 * @returns whether an event is permitted to be assembled and sent.
 */
function consentAllowsTracking(): boolean {
  // Withdrawn / never-granted consent is an immediate, hard stop.
  if (!state.consentGranted) return false
  // A browser-level opt-out (DNT / GPC) overrides even a granted consent.
  return !browserSignalsOptOut()
}

/**
 * Read the two browser opt-out signals: legacy Do-Not-Track and the newer
 * Global-Privacy-Control. Either being on means "do not track".
 *
 * Reads defensively — `navigator` is absent during SSR, so it returns `false`
 * (no signal) server-side and lets the consent flag remain the gate there.
 *
 * @returns `true` when the browser asks not to be tracked.
 */
function browserSignalsOptOut(): boolean {
  // SSR / non-browser: there is no navigator to ask, so report "no opt-out signal".
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & {
    doNotTrack?: string | null
    globalPrivacyControl?: boolean
    msDoNotTrack?: string | null
  }
  const dnt = nav.doNotTrack ?? nav.msDoNotTrack
  const dntOn = dnt === '1' || dnt === 'yes'
  const gpcOn = nav.globalPrivacyControl === true
  return dntOn || gpcOn
}

// ---------------------------------------------------------------------------
// 6. The pseudonym + small env helpers (events.md §4)
// ---------------------------------------------------------------------------

/**
 * Compute the pseudonymous `actor_hash` from a raw wallet address — the ONLY way
 * an address ever enters analytics (`events.md` §4).
 *
 *   actor_hash = base64url( sha256( lowercase(address) + ANALYTICS_SALT ) ).slice(0, 16)
 *
 * Properties this guarantees (privacy-critical):
 *   - The raw address is NEVER stored — only the 16-char salted digest.
 *   - It is one-way (sha256) and truncated, so it supports funnel de-dup and
 *     `is_first_payment` but NOT re-identification.
 *   - Rotating `ANALYTICS_SALT` severs all historical linkage by design — the
 *     digest is not a stable cross-service identifier.
 *
 * `sha256` from viem is synchronous, so this stays a pure, non-async call usable
 * inline in `setActor`.
 *
 * @param address The raw wallet address (any case / `0x`-prefixed).
 * @returns the 16-char base64url pseudonym.
 */
export function computeActorHash(address: string): string {
  const preimage = address.trim().toLowerCase() + state.salt
  // viem's sha256 over the UTF-8 bytes → a 32-byte digest; encode + truncate.
  const digest = sha256(stringToBytes(preimage), 'bytes')
  return base64UrlEncode(digest).slice(0, 16)
}

/**
 * Read the per-deployment analytics salt. Falls back to an empty string when
 * unset — the digest is still one-way and useful for in-session de-dup, and the
 * deployment is expected to supply `NEXT_PUBLIC_ANALYTICS_SALT`. The salt is NOT
 * a secret (it only governs cross-rotation linkage), so a public env var is fine.
 *
 * @returns the salt string (possibly empty).
 */
function readSalt(): string {
  // Guard process access so this module imports cleanly in any runtime.
  const env =
    typeof process !== 'undefined' && process.env ? process.env : undefined
  return (env?.NEXT_PUBLIC_ANALYTICS_SALT ?? '').trim()
}

/**
 * Base64url-encode raw bytes (RFC 4648 §5: `+`→`-`, `/`→`_`, no `=` padding).
 * Used only for the {@link computeActorHash} digest, so it stays small + dep-free.
 *
 * @param bytes The digest bytes to encode.
 * @returns the base64url string.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  // `btoa` exists in the browser and in modern Node; encode then make it URL-safe.
  const b64 = btoa(binary)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Generate a random, non-identifying id for `anonymous_id` / `session_id`. Uses
 * the platform crypto UUID where present, with a non-crypto fallback. NEITHER id
 * is derived from a wallet or any identity (`events.md` §2).
 *
 * @returns a fresh random id string.
 */
function randomId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  // Prefer a real UUID; fall back to a timestamped random for exotic runtimes.
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** True in a non-production build — gates the dev-only console echo. */
function isDev(): boolean {
  return (
    typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'
  )
}

// ---------------------------------------------------------------------------
// 7. Per-event sanitizers — the STRIP-DON'T-TRUST layer (events.md §5)
// ---------------------------------------------------------------------------

/**
 * Reshape an event's properties to EXACTLY the taxonomy's declared fields,
 * copying nothing else. This is the privacy backstop: a call site that smuggles
 * a `prompt`, `address`, `email`, or raw error string into `props` has those
 * stray keys DROPPED here — only the whitelisted fields below reach the sink
 * (`events.md` §5). It never inspects values for PII (that is the type system's
 * job upstream); it enforces the SHAPE so unknown keys cannot ride along.
 *
 * @param event The typed event (name + props).
 * @returns a fresh props object containing only the taxonomy-declared keys.
 */
function sanitizeProps(event: AnalyticsEvent): AnalyticsEvent['props'] {
  switch (event.name) {
    case 'page_view':
      return pick(event.props, ['referrer_class', 'is_embed_host'])
    case 'connect_wallet':
      return pick(event.props, ['status', 'connector', 'error_code'])
    case 'register_merchant_start':
      return pick(event.props, ['entry', 'has_ens_input'])
    case 'register_merchant_success':
      return pick(event.props, [
        'fee_bps',
        'payout_kind',
        'tx_class',
        'latency_bucket',
      ])
    case 'checkout_view':
      return pick(event.props, [
        'checkout_kind',
        'amount_bucket',
        'token_symbol',
        'gate',
      ])
    case 'pay_initiated':
      return pick(event.props, [
        'method',
        'token_symbol',
        'amount_bucket',
        'quote_source',
        'gate_passed',
      ])
    case 'pay_success':
      return pick(event.props, [
        'method',
        'token_symbol',
        'amount_bucket',
        'latency_bucket',
        'is_first_payment',
      ])
    case 'pay_fail':
      return pick(event.props, ['method', 'reason', 'token_symbol', 'amount_bucket'])
    case 'assistant_query':
      return pick(event.props, ['query_length_bucket', 'status', 'latency_bucket'])
    case 'onramp_start':
      return pick(event.props, ['funding_kind', 'provider_class', 'amount_bucket'])
  }
}

/**
 * Copy ONLY the listed keys from `source` into a fresh object — the allowlist
 * primitive behind {@link sanitizeProps}. A key absent from `source` is simply
 * omitted; a key present in `source` but absent from `keys` is dropped.
 *
 * @param source The untrusted props object.
 * @param keys   The taxonomy's allowed keys for this event.
 * @returns a new object with only the allowed, present keys.
 */
function pick<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const key of keys) {
    // Copy only own, declared keys — never inherited / smuggled extras.
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key]
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 8. The public API — configure, set context, and track (events.md §6/§7)
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link configureAnalytics}. Every field is optional; an
 * omitted field leaves the current safe value untouched.
 */
export interface ConfigureOptions {
  /** The first-party sink, or `null` to disable (the off-by-default no-op). */
  sink?: AnalyticsSink | null
  /** Override the per-deployment salt (else read from env). */
  salt?: string
  /** The surface the app shell is rendering. */
  surface?: Surface
}

/**
 * Configure the tracker once at app start (provider/layout). With no sink (the
 * default), `track()` is a no-op — nothing leaves the browser (`events.md` §6).
 *
 * @param options The sink + optional salt/surface. See {@link ConfigureOptions}.
 */
export function configureAnalytics(options: ConfigureOptions = {}): void {
  if (options.sink !== undefined) state.sink = options.sink
  if (typeof options.salt === 'string') state.salt = options.salt.trim()
  if (options.surface) state.surface = options.surface
}

/**
 * Grant consent. Until this is called (or after {@link withdrawConsent}),
 * `track()` is a hard no-op (`events.md` §5.7). Granting does NOT, by itself,
 * send anything — events still pass the DNT/GPC + sink gates.
 */
export function grantConsent(): void {
  state.consentGranted = true
}

/**
 * Withdraw consent. Stops all emission AND regenerates `anonymous_id` so the
 * prior browser id cannot be re-correlated (`events.md` §2/§5.7). The actor hash
 * is cleared too — there is no actor to attribute once consent is gone.
 */
export function withdrawConsent(): void {
  state.consentGranted = false
  state.anonymousId = randomId()
  state.actorHash = null
}

/** Whether tracking is currently permitted (consent granted AND no DNT/GPC). */
export function isTrackingEnabled(): boolean {
  return consentAllowsTracking()
}

/**
 * Set the current route context on every navigation. `pathTemplate` MUST be the
 * Next.js route PATTERN (`/c/[slug]`), never a resolved slug/id/query (privacy
 * §5.2). The caller (the layout's route-change effect) is responsible for passing
 * the template; this function does not, and cannot, see the live URL.
 *
 * @param pathTemplate The route template for the rendered route.
 * @param surface      Optional surface override for this route.
 */
export function setRouteContext(pathTemplate: string, surface?: Surface): void {
  state.pathTemplate = pathTemplate
  if (surface) state.surface = surface
}

/**
 * Set (or clear) the chain in context. Only a {@link SupportedChainId} is kept;
 * any other id is treated as "no chain" (`null`) so an unsupported/ mainnet id can
 * never appear on an event (repo law #4).
 *
 * @param chainId The chain id, or `null` to clear.
 */
export function setChainContext(chainId: number | null): void {
  state.chainId = isSupportedChainId(chainId) ? chainId : null
}

/**
 * Set or clear the actor from a RAW wallet address. The address is reduced to
 * `actor_hash` HERE (via {@link computeActorHash}) and the raw value is discarded
 * immediately — it is never stored on `state` and never reaches a sink
 * (`events.md` §4, privacy §5.1). Pass `null` on disconnect.
 *
 * @param address The connected wallet address, or `null` to clear the actor.
 */
export function setActor(address: string | null): void {
  // A blank / null address means "no actor" — the envelope carries actor_hash=null.
  state.actorHash =
    typeof address === 'string' && address.trim().length > 0
      ? computeActorHash(address)
      : null
}

/**
 * Emit one analytics event — the single chokepoint every call site uses.
 *
 * This function is a HARD NO-OP unless ALL gates pass (`events.md` §5/§6):
 *   1. consent is granted, and the browser is not signalling DNT / GPC;
 *   2. a sink is configured (off by default → nothing leaves the browser).
 *
 * When it does emit, it builds the envelope ITSELF (the caller never supplies
 * envelope fields, so no PII can enter there), runs the event's props through
 * {@link sanitizeProps} (dropping any smuggled keys), and hands the result to the
 * sink. A throwing/rejecting sink is isolated — `track()` never throws into the
 * call site, so a logging failure can never break a money path (doctrine law #5).
 *
 * @param event The typed event: `{ name, props }`. The union makes `props`
 *              exhaustively match `name` at compile time.
 */
export function track(event: AnalyticsEvent): void {
  // Gate 1 — consent + browser opt-out. The most important line in the file.
  if (!consentAllowsTracking()) return
  // Gate 2 — a configured sink. No sink → off by default → nothing emitted.
  const sink = state.sink
  if (!sink) return

  // Build the envelope here so the caller can never set a PII-bearing field.
  const payload: AnalyticsPayload = {
    event: event.name,
    schema_version: SCHEMA_VERSION,
    ts: Date.now(),
    anonymous_id: state.anonymousId,
    session_id: state.sessionId,
    surface: state.surface,
    app_env: resolveAppEnv(),
    path_template: state.pathTemplate,
    chain_id: state.chainId,
    actor_hash: state.actorHash,
    consent: 'granted',
    // Allowlist-copy the props so no smuggled key (prompt/address/error) rides along.
    props: sanitizeProps(event),
  }

  // Deliver best-effort. A sink that throws synchronously or rejects async is
  // swallowed — emission is informational and must never surface to the caller.
  try {
    void Promise.resolve(sink.send(payload)).catch(swallow)
  } catch {
    // Synchronous sink error: isolated exactly like the async path above.
  }
}

// ---------------------------------------------------------------------------
// 9. Small internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the `app_env` field. This build is testnet-only by repo law; `local`
 * is reported only in a non-production runtime, and `mainnet` is never emitted.
 *
 * @returns `'local'` in dev, otherwise `'testnet'`.
 */
function resolveAppEnv(): AppEnv {
  return isDev() ? 'local' : 'testnet'
}

/**
 * Narrow an arbitrary number to a {@link SupportedChainId}. Used by
 * {@link setChainContext} so an unsupported (or mainnet) id is rejected as "no
 * chain in context" rather than leaking onto an event.
 *
 * @param id The candidate chain id (or `null`).
 * @returns whether `id` is one of the supported testnet ids.
 */
export function isSupportedChainId(id: number | null): id is SupportedChainId {
  return id === ARC_TESTNET_ID || id === 84532 || id === 300
}

/** A no-op error sink — the async-rejection handler for a best-effort sink send. */
function swallow(): void {
  // Intentionally empty: a sink failure is isolated from the call site (law #5).
}

// ---------------------------------------------------------------------------
// 10. Test-only reset (NOT used by any production path)
// ---------------------------------------------------------------------------

/**
 * Reset the tracker to its safe defaults. For unit tests only — it lets a test
 * file start from a known no-consent, no-sink state. No production code calls it.
 */
export function __resetAnalytics(): void {
  state.consentGranted = false
  state.sink = null
  state.salt = readSalt()
  state.anonymousId = randomId()
  state.sessionId = randomId()
  state.surface = 'marketing'
  state.pathTemplate = '/'
  state.chainId = null
  state.actorHash = null
}
