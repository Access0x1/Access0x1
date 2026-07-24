/**
 * integrations.ts — THE registry of every external API/key the app can use.
 *
 * THE POINT: adding a new API is ONE declarative entry here — not a hunt through
 * routes, docs, `.env.example`, and a status page. Everything else derives from
 * this table:
 *   - `npm run env:doctor`  → what's set / missing / partially configured
 *   - the status probe      → per-integration `configured` booleans (never values)
 *   - onboarding docs       → where to get each key, what it unlocks
 *
 * DOCTRINE (unchanged, encoded here):
 *   - Every integration is ENV-GATED + FAIL-SOFT: blank ⇒ the seam is dormant and
 *     the app runs normally. `required: true` on a var means "required *for this
 *     integration to switch on*", never "required for the app to boot".
 *   - SECRETS ARE SERVER-ONLY. `secret: true` marks a value that must never reach
 *     a client bundle, a log, or a commit. Nothing here ever holds a VALUE — only
 *     the NAME of the variable and what it's for.
 *   - No endpoint is hardcoded as truth: `where` tells an operator where to get
 *     the real value from official docs, so we never guess one.
 */

/** What a missing integration costs — used to sort the doctor's output. */
export type IntegrationImpact =
  /** The demo/pitch visibly needs it. */
  | 'demo'
  /** A real feature switches off, but the app is fine. */
  | 'feature'
  /** Nice to have; almost always fine unset. */
  | 'optional'

/** One environment variable an integration reads. */
export interface EnvVarSpec {
  /** The exact variable name (matches `.env.example` and the code that reads it). */
  readonly name: string
  /** One line: what this value is. Never contains a value. */
  readonly purpose: string
  /** True when the integration cannot switch on without it. */
  readonly required?: boolean
  /** True when the value is a SECRET — server-only, never client/logged/committed. */
  readonly secret?: boolean
  /** True when a sane default applies if unset (so "missing" isn't a problem). */
  readonly hasDefault?: boolean
}

/** One external API / capability the app can be configured with. */
export interface Integration {
  /** Stable id (kebab-case) — the doctor + status probe key. */
  readonly id: string
  /** Human label. */
  readonly label: string
  /** What turning this on actually unlocks, in plain English. */
  readonly unlocks: string
  /** How much its absence costs. */
  readonly impact: IntegrationImpact
  /** Where an operator gets the credentials (official source — never a guess). */
  readonly where: string
  /** The variables this integration reads. */
  readonly vars: readonly EnvVarSpec[]
}

/**
 * THE REGISTRY. Add a new API here and it automatically appears in the doctor,
 * the status probe, and the operator docs. Keep `unlocks` honest — it is read by
 * humans deciding what to configure next.
 */
export const INTEGRATIONS: readonly Integration[] = [
  {
    id: 'uniswap',
    label: 'Uniswap Trading API',
    unlocks: 'Receive-in-any-coin payout swaps (gasless / classic / smart-account) off the money path.',
    impact: 'demo',
    where: 'hub.uniswap.org — create an app, copy the Trading API key.',
    vars: [
      { name: 'UNISWAP_TRADING_API_URL', purpose: 'Trading API base URL', required: true },
      { name: 'UNISWAP_TRADING_API_KEY', purpose: 'x-api-key for the Trading API', secret: true },
    ],
  },
  {
    id: 'oneinch',
    label: '1inch Swap API',
    unlocks: 'The 1inch payout rail + the agent pay-any-token quote (mainnets only — read-only demo on testnets).',
    impact: 'demo',
    where: 'portal.1inch.dev — free Dev plan, copy the API key.',
    vars: [
      { name: 'ONEINCH_API_URL', purpose: 'Swap API base URL including the chain segment', required: true },
      { name: 'ONEINCH_API_KEY', purpose: 'Bearer token for the 1inch API', secret: true },
    ],
  },
  {
    id: 'anthropic',
    label: 'Claude (default AI provider)',
    unlocks: 'The docs assistant, the judge Q&A bot, and /api/ai/infer when the provider is anthropic.',
    impact: 'demo',
    where: 'console.anthropic.com — API keys.',
    vars: [{ name: 'CLAUDE_API_KEY', purpose: 'Anthropic API key', required: true, secret: true }],
  },
  {
    id: 'inference-provider',
    label: 'AI provider switch',
    unlocks: 'Which backend answers inference: anthropic | zerog | access0x1 | custom (one env var).',
    impact: 'optional',
    where: 'No key — a selector. Blank ⇒ anthropic.',
    vars: [
      { name: 'AI_INFERENCE_PROVIDER', purpose: 'anthropic | zerog | access0x1 | custom', hasDefault: true },
    ],
  },
  {
    id: 'zerog-compute',
    label: '0G Compute (decentralized inference)',
    unlocks: 'The "Computed on 0G Compute" badge — inference served by 0G instead of Anthropic.',
    impact: 'feature',
    where: 'Key mode: a 0G Compute endpoint + key. Broker mode: a funded 0G testnet wallet (see docs/0G-COMPUTE-INFERENCE.md).',
    vars: [
      { name: 'ZEROG_COMPUTE_ENDPOINT', purpose: 'OpenAI-compatible base URL (key mode)' },
      { name: 'ZEROG_COMPUTE_API_KEY', purpose: 'API key (key mode)', secret: true },
      { name: 'ZEROG_MODE', purpose: 'key | broker', hasDefault: true },
      { name: 'ZEROG_BROKER_PRIVATE_KEY', purpose: 'Funded 0G wallet that settles inference fees (broker mode)', secret: true },
      { name: 'ZEROG_PROVIDER_ADDRESS', purpose: 'The 0G Compute provider to route to (broker mode)' },
    ],
  },
  {
    id: 'custom-compute',
    label: 'Bring-your-own inference endpoint',
    unlocks: 'Any OpenAI-compatible vendor as the AI backend — no lock-in.',
    impact: 'optional',
    where: "Your vendor's OpenAI-compatible base URL.",
    vars: [
      { name: 'CUSTOM_COMPUTE_ENDPOINT', purpose: 'OpenAI-compatible base URL', required: true },
      { name: 'CUSTOM_COMPUTE_API_KEY', purpose: 'Optional bearer key', secret: true },
      { name: 'CUSTOM_COMPUTE_MODEL', purpose: 'Optional model id', hasDefault: true },
    ],
  },
  {
    id: 'dynamic',
    label: 'Dynamic (merchant wallet auth)',
    unlocks: 'Merchant sign-in, the agent MPC server wallet, and verified-session writes.',
    impact: 'demo',
    where: 'app.dynamic.xyz — environment id + API token.',
    vars: [
      { name: 'NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID', purpose: 'Public environment id (client)', required: true },
      { name: 'DYNAMIC_JWT_ISSUER', purpose: 'JWT issuer for verifying sessions server-side' },
      { name: 'DYNAMIC_AUTH_TOKEN', purpose: 'Server API token (MPC wallet ops)', secret: true },
    ],
  },
  {
    id: 'ens-subnames',
    label: 'ENS subnames (Namestone)',
    unlocks: 'Issuing pay.<business>.eth subnames — the front door of onboarding.',
    impact: 'demo',
    where: 'namestone.com — API key, plus an ENS name you control as the parent.',
    vars: [
      { name: 'NAMESTONE_API_KEY', purpose: 'Namestone API key', required: true, secret: true },
      { name: 'ENS_SUBNAME_PARENT', purpose: 'The ENS name subnames are issued under', required: true },
    ],
  },
  {
    id: 'world-id',
    label: 'World ID (proof of personhood)',
    unlocks: 'The verified-human checkout gate and the ✓ rung on the verification ladder.',
    impact: 'feature',
    where: 'developer.worldcoin.org — create an app + action.',
    vars: [
      { name: 'NEXT_PUBLIC_WORLD_APP_ID', purpose: 'World app id (client)', required: true },
      { name: 'WORLD_ACTION', purpose: 'The action string the buyer gate verifies', hasDefault: true },
    ],
  },
  {
    id: 'agent',
    label: 'Agent (x402 earn/spend)',
    unlocks: 'The autonomous pay loop: the agent earns and spends from its own bounded wallet.',
    impact: 'demo',
    where: 'Set after the Dynamic wallet exists; caps/allowlist are yours to choose.',
    vars: [
      { name: 'AGENT_WALLET_ID', purpose: 'The agent MPC wallet id', required: true },
      { name: 'AGENT_DAILY_USD_CAP', purpose: 'Hard daily spend ceiling (0 blocks everything)', required: true },
      { name: 'AGENT_URL_ALLOWLIST', purpose: 'Comma-separated origins the agent may pay (deny-all when blank)', required: true },
      { name: 'AGENT_INTERNAL_SECRET', purpose: 'Shared secret gating /api/agent/pay', secret: true },
    ],
  },
  {
    id: 'state-anchor',
    label: 'Agent memory anchor (Walrus + provenance)',
    unlocks: 'earn → store → own: the agent’s memory content-addressed on Walrus and anchored on-chain.',
    impact: 'feature',
    where: 'A Sui testnet account for Walrus; the ProvenanceRegistry address from your broadcast records.',
    vars: [
      { name: 'AGENT_STATE_ANCHOR', purpose: 'Set "true" to switch the anchor loop on', required: true },
      { name: 'AGENT_ANCHOR_REGISTRY', purpose: 'ProvenanceRegistry address (from broadcast/)' },
      { name: 'AGENT_ANCHOR_PRIVATE_KEY', purpose: 'Testnet key that submits the anchor tx', secret: true },
      { name: 'WALRUS_PUBLISHER', purpose: 'Walrus publisher base URL', hasDefault: true },
    ],
  },
  {
    id: 'rpc',
    label: 'RPC endpoints (QuickNode or any provider)',
    unlocks: 'Reliable per-chain reads/writes. Blank ⇒ public defaults (rate-limited).',
    impact: 'optional',
    where: 'quicknode.com (or any provider) — one HTTPS endpoint per chain.',
    vars: [
      { name: 'NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL', purpose: 'Base Sepolia RPC', hasDefault: true },
      { name: 'NEXT_PUBLIC_ZKSYNC_SEPOLIA_RPC_URL', purpose: 'zkSync Sepolia RPC', hasDefault: true },
    ],
  },
] as const

/** Reading env without depending on a runtime — the doctor passes a parsed file. */
export type EnvLookup = (name: string) => string | undefined

/** Whether a value counts as SET (non-empty after trim). */
export function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/** Per-integration status: on, off, or partially configured (the dangerous middle). */
export type IntegrationState = 'configured' | 'partial' | 'off'

/** The computed status of one integration. */
export interface IntegrationStatus {
  readonly id: string
  readonly label: string
  readonly impact: IntegrationImpact
  readonly state: IntegrationState
  /** Required vars that are still missing (the exact blockers). */
  readonly missingRequired: string[]
  /** Optional vars not set (informational only). */
  readonly missingOptional: string[]
  /** True when every REQUIRED var is set. */
  readonly ready: boolean
}

/**
 * Compute one integration's status from an env lookup. NEVER returns a value —
 * only names and booleans, so this is safe to log, serve, or print.
 *
 * `partial` means: something is set but a required var is missing — the state most
 * likely to look "on" while silently failing, so the doctor calls it out loudest.
 */
export function statusOf(integration: Integration, env: EnvLookup): IntegrationStatus {
  const required = integration.vars.filter((v) => v.required)
  const optional = integration.vars.filter((v) => !v.required && !v.hasDefault)

  const missingRequired = required.filter((v) => !isSet(env(v.name))).map((v) => v.name)
  const missingOptional = optional.filter((v) => !isSet(env(v.name))).map((v) => v.name)

  const anySet = integration.vars.some((v) => isSet(env(v.name)))
  const ready = missingRequired.length === 0 && (required.length > 0 || anySet)

  const state: IntegrationState = ready ? 'configured' : anySet ? 'partial' : 'off'
  return {
    id: integration.id,
    label: integration.label,
    impact: integration.impact,
    state,
    missingRequired,
    missingOptional,
    ready,
  }
}

/** Every integration's status, in registry order. Safe to serialize (no values). */
export function allStatuses(env: EnvLookup): IntegrationStatus[] {
  return INTEGRATIONS.map((i) => statusOf(i, env))
}

/** Look up one integration by id (or undefined). */
export function getIntegration(id: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.id === id)
}

/** Every variable name the registry knows about — used to spot undocumented vars. */
export function allKnownVarNames(): string[] {
  return [...new Set(INTEGRATIONS.flatMap((i) => i.vars.map((v) => v.name)))]
}

/** Every SECRET variable name — never log, never bundle, never commit these. */
export function secretVarNames(): string[] {
  return [...new Set(INTEGRATIONS.flatMap((i) => i.vars.filter((v) => v.secret).map((v) => v.name)))]
}
