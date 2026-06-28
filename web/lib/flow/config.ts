/**
 * config.ts — the OPTIONAL "pay in any token → settle USDC" env seam (Flow).
 *
 * "Pay with the coin you already hold": a buyer/agent holding some arbitrary
 * token (not necessarily one of the Router's allowlisted, Chainlink-priced pay
 * tokens) asks to pay an invoice; an off-path SWAP converts that token into the
 * USDC the existing pay path settles in, which then flows into the unchanged
 * CheckoutCard → payToken path. The swap sits IN FRONT of pay, never on the
 * Solidity money path.
 *
 * ENV-GATED + DEFAULT OFF (mirrors lib/onramp/config.ts and lib/funding/blink.ts):
 *   - One place reads whether the Flow option is on (`NEXT_PUBLIC_FLOW_ENABLED`)
 *     and its public config (`NEXT_PUBLIC_FLOW_*`), so turning it on/off or
 *     repointing it is an ENV change, never a code change.
 *   - With NOTHING set the seam is OFF: the "pay in any token" option is HIDDEN
 *     and nothing changes — native/USDC pay behaves exactly as today.
 *
 * GENERIC BY DESIGN: NO swap aggregator is hardcoded in code. Which swap route
 * runs is chosen by `FLOW_PROVIDER`, and the public app/api id comes from
 * `NEXT_PUBLIC_FLOW_APP_ID`. The public integration-target names appear only as
 * the documented set of valid `FLOW_PROVIDER` values, never as a baked-in default
 * endpoint.
 *
 * TRUTH (law #4 — see lib/flow/index.ts): no real swap SDK is integrated in this
 * repo. The swap STEP is a documented adapter/stub; until an aggregator is wired
 * the seam reports `swap_adapter_unavailable` and the option never claims a token
 * was "swapped" or "settled". This file only describes the ENV surface + gating.
 */

/**
 * The set of swap providers the Flow seam knows how to NAME (an aggregator/router
 * that quotes + swaps an arbitrary token into USDC). These are PUBLIC
 * integration-target names, selected by env — NOT a default. An unknown/blank
 * value ⇒ the seam treats the provider as unselected (fail-soft).
 *
 * NOTE: naming a provider here does NOT mean its SDK is installed — the actual
 * swap is performed by the adapter in `index.ts`, which is a documented stub
 * until an aggregator is wired (law #4: a named provider is not a working swap).
 */
export const KNOWN_FLOW_PROVIDERS = [
  'lifi',
  'uniswap',
  'oneinch',
  'paraswap',
  '0x',
] as const

export type FlowProvider = (typeof KNOWN_FLOW_PROVIDERS)[number]

/**
 * True only when the Flow "pay in any token" option is explicitly enabled via
 * `NEXT_PUBLIC_FLOW_ENABLED` (truthy: "1" / "true" / "yes" / "on",
 * case-insensitive). Blank/unset ⇒ OFF (default). PUBLIC so a client component
 * can read the same flag the server does — when off NOTHING changes.
 */
export function isFlowEnabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FLOW_ENABLED ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * The selected swap provider id from `FLOW_PROVIDER` (lower-cased, trimmed), or
 * `undefined` when blank/unknown. There is NO default provider on purpose: a swap
 * moves real value, so the operator names one explicitly. An unknown value
 * returns `undefined` (treated as unconfigured) rather than guessing. SERVER-side
 * (no NEXT_PUBLIC_) so the chosen route isn't inlined into the browser bundle.
 */
export function flowProvider(): FlowProvider | undefined {
  const v = (process.env.FLOW_PROVIDER ?? '').trim().toLowerCase()
  return (KNOWN_FLOW_PROVIDERS as readonly string[]).includes(v)
    ? (v as FlowProvider)
    : undefined
}

/**
 * The PUBLIC app/api id the chosen swap aggregator identifies this integration by
 * (`NEXT_PUBLIC_FLOW_APP_ID`). PUBLIC — it accompanies a client-side quote. Blank
 * ⇒ unconfigured. NO hardcoded default — an app id is deployment-specific and a
 * guessed value would point at the wrong account (law #4: never invent one).
 */
export function flowAppId(): string {
  return (process.env.NEXT_PUBLIC_FLOW_APP_ID ?? '').trim()
}

/**
 * The asset the swap SETTLES INTO (`NEXT_PUBLIC_FLOW_SETTLE_ASSET`), defaulting to
 * USDC — the asset the existing pay path settles in. PUBLIC. We default to the
 * settlement asset so the swapped output drops straight into the unchanged pay
 * path; an override exists only for a deployment whose pay path settles elsewhere.
 */
export function flowSettleAsset(): string {
  const v = (process.env.NEXT_PUBLIC_FLOW_SETTLE_ASSET ?? '').trim()
  return v.length > 0 ? v : 'USDC'
}

/**
 * OPTIONAL server-only key some aggregators require to fetch a firm quote / sign a
 * route (`FLOW_SERVER_KEY`). SERVER-ONLY: never NEXT_PUBLIC_, never placed in a
 * response body or a client URL (secrets law). Blank ⇒ the seam relies on the
 * public app id alone; a provider that strictly requires a server key reports
 * unavailable for that leg rather than leaking or faking a key.
 */
export function flowServerKey(): string {
  return (process.env.FLOW_SERVER_KEY ?? '').trim()
}

/**
 * True only when the Flow swap option can actually run on the SERVER: it is
 * enabled AND a known provider IS selected AND a public app id is configured. When
 * false the option is hidden and any swap call returns `not_configured` — honest,
 * never a faked "ready" (law #4). The swap ADAPTER's presence is a SEPARATE, later
 * check (in index.ts), so a configured-but-no-adapter deployment still fails soft
 * with `swap_adapter_unavailable` rather than claiming a swap happened.
 */
export function isFlowConfigured(): boolean {
  return isFlowEnabled() && flowProvider() !== undefined && flowAppId().length > 0
}

/**
 * CLIENT-SAFE configured check for a client component (CheckoutCard). The provider
 * select `FLOW_PROVIDER` is server-only and NOT inlined into the browser bundle,
 * so the client gates the "pay in any token" option on the PUBLIC flag + app id
 * (`NEXT_PUBLIC_FLOW_ENABLED` + `NEXT_PUBLIC_FLOW_APP_ID`) only — either blank ⇒
 * the option is hidden. The full {@link isFlowConfigured} (which also requires a
 * known provider) still guards the route/seam that BUILDS the swap, so this only
 * DECIDES VISIBILITY, never performs the swap.
 */
export function isFlowPublicConfigured(): boolean {
  return isFlowEnabled() && flowAppId().length > 0
}

/**
 * A one-line, honest "configure me" note for logs / a health endpoint. Names the
 * env vars an installer sets to turn the Flow option on — and the set of valid
 * providers — never baking one in. Also states the truth: naming a provider does
 * NOT install its swap SDK (see index.ts adapter).
 */
export const FLOW_CONFIGURE_NOTE =
  'Set NEXT_PUBLIC_FLOW_ENABLED=true + FLOW_PROVIDER (one of: ' +
  KNOWN_FLOW_PROVIDERS.join(', ') +
  ') + NEXT_PUBLIC_FLOW_APP_ID to surface the "pay in any token → USDC" option; ' +
  'optionally NEXT_PUBLIC_FLOW_SETTLE_ASSET and a server-only FLOW_SERVER_KEY. ' +
  'Blank ⇒ the option is HIDDEN (default OFF). NOTE: a named provider is only the ' +
  'SEAM — the actual swap runs through the adapter in lib/flow/index.ts, a ' +
  'documented stub until an aggregator SDK is wired (no token is "swapped" until then).'
