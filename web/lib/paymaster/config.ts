/**
 * config.ts — the ERC-7677 / EIP-5792 sponsored-gas paymaster env seam.
 *
 * A paymaster sponsors the gas cost of a user operation so the payer never has
 * to hold the chain's native gas token. This seam models the Base Paymaster
 * shape (a JSON-RPC endpoint that implements `pm_getPaymasterStubData` +
 * `pm_getPaymasterData` as specified in ERC-7677) but is GENERIC BY DESIGN:
 * pointing it at any ERC-7677-compliant paymaster is an ENV change, never a
 * code change. The provider (Base / Coinbase / Alchemy / custom) is named ONLY
 * in the operator-fill placeholder comment, not as a baked-in constant.
 *
 * GENERIC + FAIL-SOFT (mirrors lib/oidc/config.ts and lib/onramp/config.ts):
 *   - Three env vars gate the feature: PAYMASTER_ENABLED (server-only flag),
 *     NEXT_PUBLIC_PAYMASTER_URL (the public JSON-RPC endpoint), and
 *     NEXT_PUBLIC_PAYMASTER_CHAIN_ID (the chain id it operates on).
 *   - Unset / blank ⇒ the seam is UNCONFIGURED — `isPaymasterConfigured()` and
 *     `isPaymasterPublicConfigured()` both return false. The badge in CheckoutCard
 *     is hidden and the call path falls back to the normal (user-pays-gas) flow.
 *     The seam NEVER throws; every function returns a safe default.
 *   - TRUTH-IN-COPY (law #4): the badge ONLY appears when the paymaster URL is
 *     configured AND the active checkout chain id matches
 *     NEXT_PUBLIC_PAYMASTER_CHAIN_ID. A paymaster for chain A does NOT sponsor
 *     gas on chain B; we never claim "gas sponsored" on a chain we can't confirm.
 *
 * ERC-7677 / EIP-5792 context:
 *   ERC-7677 defines the two JSON-RPC methods (`pm_getPaymasterStubData`,
 *   `pm_getPaymasterData`) a bundler calls against the paymaster URL to obtain
 *   the paymaster-and-data field for a UserOperation, plus an optional capability
 *   object (`paymasterService`) that a wallet / app communicates via EIP-5792's
 *   `wallet_sendCalls` capabilities. This seam exposes the PUBLIC parts (URL,
 *   chain id, capability) so the checkout UI can attach the capability when
 *   calling `wallet_sendCalls` — the paymaster itself runs off-chain at the URL.
 *
 * What this seam does NOT do:
 *   - It never calls `pm_getPaymasterStubData` / `pm_getPaymasterData` directly;
 *     those are bundler-side; the wallet handles them when given the capability.
 *   - It never handles any API secret: a paymaster URL MAY contain a public path
 *     token (not a secret), but any server-side key used to MINT a paymaster
 *     token is kept server-only and never placed in the client bundle.
 *   - It never invents an address. If the chain is not configured, the badge is
 *     hidden and the flow falls back gracefully.
 */

// ---------------------------------------------------------------------------
// Feature flag — is the paymaster feature enabled at all?
// ---------------------------------------------------------------------------

/**
 * True when `PAYMASTER_ENABLED` is exactly the string "true" (case-insensitive,
 * trimmed). This is a SERVER-ONLY flag (no `NEXT_PUBLIC_` prefix) so an operator
 * can enable/disable the paymaster without touching client-visible config. When
 * false (or blank), the paymaster seam is completely dormant regardless of other
 * vars.
 */
export function isPaymasterEnabled(): boolean {
  return (process.env.PAYMASTER_ENABLED ?? '').trim().toLowerCase() === 'true'
}

// ---------------------------------------------------------------------------
// Public endpoint — where the paymaster JSON-RPC lives
// ---------------------------------------------------------------------------

/**
 * The PUBLIC JSON-RPC endpoint for the ERC-7677 paymaster service
 * (`NEXT_PUBLIC_PAYMASTER_URL`). This is the URL a wallet calls to request
 * `pm_getPaymasterStubData` / `pm_getPaymasterData`.
 *
 * PUBLIC — it is passed to the wallet as part of the EIP-5792 capability object
 * and is NOT a secret. A path token embedded in the URL (some providers put a
 * public project id here) is acceptable; a secret key MUST use a server-side
 * proxy instead and MUST NOT appear in `NEXT_PUBLIC_PAYMASTER_URL`.
 *
 * Returns '' when not configured — callers treat the empty string as unconfigured.
 */
export function paymasterUrl(): string {
  return (process.env.NEXT_PUBLIC_PAYMASTER_URL ?? '').trim()
}

// ---------------------------------------------------------------------------
// Chain scope — which chain does this paymaster operate on?
// ---------------------------------------------------------------------------

/**
 * The chain id the configured paymaster operates on
 * (`NEXT_PUBLIC_PAYMASTER_CHAIN_ID`). A paymaster sponsors gas on ONE chain; it
 * is NOT chain-agnostic. Pinning the chain id here lets the checkout badge be
 * shown ONLY when the active checkout chain matches — so we never claim "gas
 * sponsored" on a chain the configured endpoint does not cover (law #4).
 *
 * Returns 0 when not configured (treated as unconfigured by all consumers).
 * We intentionally avoid a non-zero fallback: picking a wrong default chain id
 * would show a false "gas sponsored" badge.
 */
export function paymasterChainId(): number {
  const raw = (process.env.NEXT_PUBLIC_PAYMASTER_CHAIN_ID ?? '').trim()
  const n = raw.length > 0 ? Number(raw) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ---------------------------------------------------------------------------
// Configured predicates
// ---------------------------------------------------------------------------

/**
 * True when the paymaster is fully configured server-side: the feature is
 * enabled AND a paymaster URL AND a non-zero chain id are set.
 *
 * Use this on the SERVER where `PAYMASTER_ENABLED` is readable. When false, the
 * API route can immediately return `not_configured` (503) rather than forwarding
 * to a missing paymaster endpoint.
 */
export function isPaymasterConfigured(): boolean {
  return isPaymasterEnabled() && paymasterUrl().length > 0 && paymasterChainId() > 0
}

/**
 * CLIENT-SAFE configured check for use in client components (e.g. CheckoutCard).
 *
 * The server-only `PAYMASTER_ENABLED` is NOT inlined into the browser bundle, so
 * the client gates the badge on the PUBLIC vars only (`NEXT_PUBLIC_PAYMASTER_URL`
 * + `NEXT_PUBLIC_PAYMASTER_CHAIN_ID`). Both must be non-blank/non-zero for the
 * badge to appear. The full {@link isPaymasterConfigured} (which also checks the
 * server-only flag) still guards any API route that PROXIES a paymaster request.
 *
 * Truth-in-copy (law #4): this returning true is NECESSARY but not SUFFICIENT for
 * the badge to appear in the UI — the checkout also requires the active chain to
 * match {@link paymasterChainId}. Only when BOTH conditions hold do we display
 * "gas sponsored — you pay $0".
 */
export function isPaymasterPublicConfigured(): boolean {
  return paymasterUrl().length > 0 && paymasterChainId() > 0
}

/**
 * Returns true when the paymaster is publicly configured AND covers the given
 * `chainId`. This is the single function the checkout badge should call — it
 * enforces both the "paymaster exists" and "paymaster covers THIS chain" checks
 * in one place so the badge logic cannot accidentally omit the chain guard.
 *
 * Example: a paymaster configured for Base Sepolia (84532) returns false for
 * Arc Testnet (5042002) — we never claim gas is sponsored on a chain we can't
 * confirm. Pass the active checkout `chainId` directly from the page props.
 */
export function isPaymasterActiveForChain(chainId: number): boolean {
  return isPaymasterPublicConfigured() && paymasterChainId() === chainId
}

// ---------------------------------------------------------------------------
// EIP-5792 capability object
// ---------------------------------------------------------------------------

/**
 * The EIP-5792 `paymasterService` capability object to attach to a
 * `wallet_sendCalls` request, per ERC-7677.
 *
 * Structure:
 * ```json
 * {
 *   "paymasterService": {
 *     "url": "<NEXT_PUBLIC_PAYMASTER_URL>"
 *   }
 * }
 * ```
 *
 * Returns `undefined` when the paymaster is not publicly configured — callers
 * must omit the capability entirely when this is undefined (omitting = standard
 * EOA flow; no crash, no guessed endpoint). The wallet uses this to call
 * `pm_getPaymasterStubData` + `pm_getPaymasterData` against the URL.
 *
 * NEVER throws.
 */
export function paymasterCapability():
  | { paymasterService: { url: string } }
  | undefined {
  const url = paymasterUrl()
  if (url.length === 0) return undefined
  return { paymasterService: { url } }
}

// ---------------------------------------------------------------------------
// Operator-facing configure note
// ---------------------------------------------------------------------------

/**
 * A one-line, honest "configure me" note for logs / a health endpoint. Names
 * the env vars an installer sets to enable sponsored gas — never a vendor.
 */
export const PAYMASTER_CONFIGURE_NOTE =
  'Set PAYMASTER_ENABLED=true + NEXT_PUBLIC_PAYMASTER_URL (the ERC-7677 JSON-RPC ' +
  'endpoint, e.g. from Base / Coinbase / Alchemy / your own paymaster) + ' +
  'NEXT_PUBLIC_PAYMASTER_CHAIN_ID (the chain id the endpoint covers) to enable ' +
  'sponsored gas. Blank / disabled ⇒ the "gas sponsored" badge is hidden (fail-soft).'
