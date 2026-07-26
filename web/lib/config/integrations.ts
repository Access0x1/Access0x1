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
  /** The live product visibly needs it — a launch blocker. */
  | 'core'
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
  /**
   * Set when the value is NOT chosen by the operator — it is minted by a system
   * and copied in afterwards.
   *
   * WHY THIS EXISTS: `AGENT_WALLET_ID` is `required: true` and prints "REQUIRED,
   * not set", which reads as "type something here". There is nothing to type —
   * the id does not exist until Dynamic mints it on first agent boot. Operators
   * repeatedly tried to fill it, and a guessed id points the agent at no wallet.
   * A required field with no answerable question needs to say so at the prompt.
   */
  readonly mintedBy?: string
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
  /**
   * Who made the tool: `ours` = built in-house (the machinery this repo authors —
   * config, keys you generate, seams we wrote); `partner` = a third party's product
   * we integrate (sponsor or vendor). Drives `env:doctor --tools`, which lists the
   * two families separately — partners are listed with the standing note that not
   * all of them sponsor every event we build at; we use them either way.
   */
  readonly origin: 'ours' | 'partner'
  /** Where an operator gets the credentials (official source — never a guess). */
  readonly where: string
  /**
   * Which env file this integration's vars live in, RELATIVE TO THE REPO ROOT.
   * Defaults to the web app's runtime env. The contract-deploy toolchain (Foundry
   * + the Makefile) reads the repo-root `.env`, NOT `web/.env.local`, so a value
   * pasted into the wrong file is silently invisible to its consumer. Declaring
   * the file here lets `env:set` write it where it will actually be read, and lets
   * `env:doctor` look for it there.
   */
  readonly envFile?: 'web/.env.local' | '.env'
  /** The variables this integration reads. */
  readonly vars: readonly EnvVarSpec[]
}

/** The env file an integration's values belong in (repo-root-relative). */
export function envFileFor(integration: Integration): string {
  return integration.envFile ?? 'web/.env.local'
}

/**
 * THE REGISTRY. Add a new API here and it automatically appears in the doctor,
 * the status probe, and the operator docs. Keep `unlocks` honest — it is read by
 * humans deciding what to configure next.
 */
export const INTEGRATIONS: readonly Integration[] = [
  {
    id: 'uniswap',
    // Was 'core'. The rail is dormant without an endpoint, and FEEDBACK.md records
    // that its TESTNET coverage was never confirmed — so it cannot be a prerequisite
    // for going live on testnets.
    label: 'Uniswap Trading API',
    unlocks: 'Receive-in-any-coin payout swaps (gasless / classic / smart-account) off the money path.',
    impact: 'feature',
    origin: 'partner',
    where: 'hub.uniswap.org — create an app, copy the Trading API key.',
    vars: [
      { name: 'UNISWAP_TRADING_API_URL', purpose: 'Trading API base URL', required: true },
      { name: 'UNISWAP_TRADING_API_KEY', purpose: 'x-api-key for the Trading API', secret: true },
    ],
  },
  {
    id: 'oneinch',
    // Was 'core', which made `env:doctor` demand a key for a rail this repo cannot
    // reach: 1inch serves no testnets, and `lib/payout-swap/capabilities.ts` maps no
    // chain to it for exactly that reason. Asking for a credential that cannot be used
    // trains an operator to ignore the doctor, which is worse than not asking.
    label: '1inch Swap API',
    unlocks: 'The 1inch payout rail + the agent pay-any-token quote (mainnets only — read-only on testnets).',
    impact: 'optional',
    origin: 'partner',
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
    impact: 'core',
    origin: 'partner',
    where: 'console.anthropic.com — API keys.',
    vars: [{ name: 'CLAUDE_API_KEY', purpose: 'Anthropic API key', required: true, secret: true }],
  },
  {
    id: 'inference-provider',
    label: 'AI provider switch',
    unlocks: 'Which backend answers inference: anthropic | zerog | access0x1 | custom (one env var).',
    impact: 'optional',
    origin: 'ours',
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
    origin: 'partner',
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
    origin: 'ours',
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
    impact: 'core',
    origin: 'partner',
    where: 'app.dynamic.xyz — environment id + API token.',
    vars: [
      { name: 'NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID', purpose: 'Public environment id (client)', required: true },
      { name: 'DYNAMIC_ENVIRONMENT_ID', purpose: 'Same id, read server-side (MPC wallet ops)' },
      { name: 'DYNAMIC_JWT_ISSUER', purpose: 'JWT issuer for verifying sessions server-side' },
      { name: 'DYNAMIC_JWT_AUDIENCE', purpose: 'JWT audience for verifying sessions server-side' },
      { name: 'DYNAMIC_AUTH_TOKEN', purpose: 'Server API token (MPC wallet ops)', secret: true },
      // Read by lib/agent/dynamicAgentWallet.ts — this is the DYNAMIC server
      // wallet's password, so it belongs here. It was previously grouped under
      // x402-seller, which meant `env:set -- dynamic` never asked for it and the
      // agent wallet failed at boot with a var the operator was never prompted for.
      { name: 'WALLET_PASSWORD', purpose: 'Unlocks the Dynamic server wallet (agent MPC)', secret: true },
    ],
  },
  {
    id: 'ens-subnames',
    label: 'ENS subnames — gasless issuer (⚠ SUNSET: NameStone ends Aug 3, 2026)',
    unlocks:
      'Gasless pay.<business>.eth subname issuance. NameStone announced shutdown effective ' +
      'Aug 3, 2026 (also enspro.xyz/enspark.xyz) — do NOT onboard a new key. Blank ⇒ subname ' +
      'issuance is a clean no-op; payments and the in-app .eth purchase are unaffected.',
    // Was 'core'. A third-party with days to live cannot be a launch blocker: demoted so the
    // doctor stops demanding a key from a dying console. The successor path is our own —
    // the ENSv2 PaymentResolver + CCIP-Read gateway (already shipped) and the in-app .eth
    // registrar ("Own your name"); an on-chain subname issuer replaces the gasless leg later.
    impact: 'optional',
    origin: 'partner',
    where:
      'DO NOT SIGN UP — namestone.com shuts down Aug 3, 2026. Existing keys work until then; ' +
      'the replacement is the in-repo resolver/registrar path (lib/ens/**).',
    vars: [
      { name: 'NAMESTONE_API_KEY', purpose: 'Legacy Namestone key (service sunsets Aug 3, 2026)', secret: true },
      { name: 'ENS_SUBNAME_PARENT', purpose: 'The ENS name subnames are issued under', required: true },
    ],
  },
  {
    id: 'ens-registrar',
    label: 'ENS purchase — Own your name (.eth, in-app)',
    unlocks:
      'Buying a real .eth name from inside the app: commit → 60s → register, signed by the ' +
      "CONNECTED wallet. Blank ⇒ the Own-your-name step is hidden; the free subname claim still works.",
    impact: 'feature',
    origin: 'partner',
    where:
      'docs.ens.domains — CONFIRM the ETHRegistrarController + Public Resolver addresses for the ' +
      'target testnet (default Sepolia). All PUBLIC: both txs are signed client-side, zero custody.',
    vars: [
      {
        name: 'NEXT_PUBLIC_ENS_REGISTRAR_CONTROLLER',
        purpose: 'ETHRegistrarController address (CONFIRM from official ENS docs). Blank ⇒ seam OFF',
        required: true,
      },
      {
        name: 'NEXT_PUBLIC_ENS_REGISTRAR_CHAIN_ID',
        purpose: 'Chain the registrar runs on (defaults to Sepolia 11155111 — testnet-only law)',
        hasDefault: true,
      },
      {
        name: 'NEXT_PUBLIC_ENS_REGISTRAR_RESOLVER',
        purpose: 'Public Resolver set at registration (enables records + primary name). Blank ⇒ bare register',
        hasDefault: true,
      },
      {
        name: 'NEXT_PUBLIC_ENS_REGISTRAR_RPC_URL',
        purpose: "RPC for registrar reads (blank ⇒ the chain's public default)",
        hasDefault: true,
      },
    ],
  },
  {
    id: 'world-id',
    label: 'World ID (proof of personhood)',
    unlocks: 'The verified-human checkout gate and the ✓ rung on the verification ladder.',
    impact: 'feature',
    origin: 'partner',
    where: 'developer.worldcoin.org — create an app + action, then an API key for the sign route.',
    vars: [
      { name: 'NEXT_PUBLIC_WORLD_APP_ID', purpose: 'World app id (client)', required: true },
      // THE REAL-vs-SIMULATOR SWITCH. Blank/anything-but-"production" ⇒ IDKit runs
      // against the Worldcoin SIMULATOR (staging verify base) — correct for dev, but
      // NOT a real proof of personhood. Set to "production" to verify against the
      // real World App. It was documented in .env.example but UNDECLARED here, so the
      // deploy silently dropped it (law 7) — an operator could flip it to production
      // locally and the live site would keep running the simulator.
      {
        name: 'NEXT_PUBLIC_WORLD_ENVIRONMENT',
        purpose: 'IDKit environment: "production" for real World App proofs; blank ⇒ staging simulator',
        hasDefault: true,
      },
      { name: 'WORLD_ACTION', purpose: 'The action string the buyer gate verifies', hasDefault: true },
      { name: 'WORLD_SIGNING_KEY', purpose: 'Server-only key that signs the World payload', secret: true },
      // Per-surface action overrides. Each defaults to a baked-in action string, so
      // leaving them blank is fine — but an operator who set a CUSTOM action in their
      // World dashboard needs it deployed, or the gate verifies the wrong action and
      // silently reverts to the default. Declared so the doctor shows them.
      { name: 'WORLD_OPERATOR_ACTION', purpose: 'Action for the operator gate (default verified-operator)', hasDefault: true },
      { name: 'WORLD_AGENT_ACTION', purpose: 'Action for the agent trial-unlock gate (default agent-trial-unlock)', hasDefault: true },
      { name: 'WORLD_AGENTKIT_ACTION', purpose: 'Action for the human-backed-agent gate (default agentkit-human-backed)', hasDefault: true },
      { name: 'WORLD_RP_ID', purpose: 'Relying-party id for the World request (blank ⇒ derived)', hasDefault: true },
    ],
  },
  {
    id: 'oidc',
    label: 'OIDC sign-in / agent identity (verify)',
    unlocks: 'The /api/oidc/verify seam — a Google (or any OIDC) token proves a human or agent identity.',
    impact: 'feature',
    origin: 'partner',
    where:
      'Your OIDC provider console (Google by default). Issuer + JWKS default to Google; the audience ' +
      'is your client id. See lib/oidc/config.ts. Blank audience ⇒ verify reports not_configured.',
    vars: [
      // Audience is the real switch: no audience ⇒ the route fails soft (never accepts an
      // unaudienced token). Issuer + JWKS have Google defaults; the client id doubles as
      // the audience when OIDC_AUDIENCE is unset.
      { name: 'NEXT_PUBLIC_OIDC_CLIENT_ID', purpose: 'Public OIDC client id (doubles as the audience)' },
      { name: 'OIDC_AUDIENCE', purpose: 'Override the expected token audience (blank ⇒ the client id)', hasDefault: true },
      { name: 'OIDC_ISSUER', purpose: 'Token issuer (default Google accounts.google.com)', hasDefault: true },
      { name: 'OIDC_JWKS_URL', purpose: 'JWKS signing-keys endpoint (default Google certs)', hasDefault: true },
      { name: 'OIDC_AGENT_CLAIM', purpose: 'Claim that marks a token as an agent identity (blank ⇒ off)', hasDefault: true },
    ],
  },
  {
    id: 'paymaster',
    label: 'Gasless (ERC-7677 paymaster)',
    unlocks: 'Sponsored gas — the buyer pays no native token. Blank ⇒ the gasless path is hidden (fail-soft).',
    impact: 'feature',
    origin: 'partner',
    where:
      'Your ERC-7677 paymaster provider (the JSON-RPC sponsorship URL). See lib/paymaster/config.ts. ' +
      'PAYMASTER_ENABLED is a server-only switch read at runtime — it must reach the deployed env.',
    vars: [
      { name: 'PAYMASTER_ENABLED', purpose: 'Server switch for gas sponsorship ("true"). Blank ⇒ OFF (fail-soft)' },
      { name: 'NEXT_PUBLIC_PAYMASTER_URL', purpose: 'ERC-7677 JSON-RPC sponsorship URL (public)' },
      { name: 'NEXT_PUBLIC_PAYMASTER_CHAIN_ID', purpose: 'Chain id the paymaster sponsors on (public)' },
    ],
  },
  {
    id: 'hardening',
    label: 'Production hardening (opt-in policy flags)',
    unlocks: 'Tighteners that are OFF by default and SET in production to fail closed. Blank ⇒ the safe dev default.',
    impact: 'feature',
    origin: 'ours',
    where: 'You choose these per deployment — no external console. Each is a boolean/flag read at runtime.',
    vars: [
      { name: 'BRANDING_REQUIRE_VERIFIED_WRITES', purpose: 'Require a verified Dynamic JWT for branding writes (prod: on)', hasDefault: true },
      { name: 'VERIFY_REQUIRE_DURABLE_STORE', purpose: 'Require a durable replay store for verify routes (prod: on)', hasDefault: true },
      { name: 'ASK_TRUST_PROXY', purpose: 'Trust the proxy IP header for the Ask/infer rate limiter (only behind a trusted proxy)', hasDefault: true },
    ],
  },
  {
    id: 'unlink',
    label: 'Unlink (private payout leg)',
    unlocks: 'The private payout rail — the agent settles without exposing the payout address on-chain.',
    impact: 'feature',
    origin: 'partner',
    where: 'Unlink — API key + the agent server payout key. See app/api/agent/pay/privateRail.ts.',
    vars: [
      { name: 'UNLINK_API_KEY', purpose: 'Unlink API key', required: true, secret: true },
      { name: 'UNLINK_PRIVATE_PAY_KEY', purpose: "The agent's server payout key", secret: true },
      { name: 'UNLINK_PAYOUT_PRIVATE_KEY', purpose: 'Testnet key that signs the private payout', secret: true },
      // The Unlink account/user id the /api/payout route pays from and checks ownership
      // against (app/api/payout/route.ts throws UnlinkNotConfiguredError without it). A
      // non-secret id, read server-side at runtime — must be in the deployed env or the
      // payout route reports not_configured even with the keys set.
      { name: 'UNLINK_PAYOUT_USER_ID', purpose: 'Unlink account id the payout route pays from (unset ⇒ payout 503s)' },
    ],
  },
  {
    id: 'fiat-ramp',
    label: 'Fiat on/off-ramp + one-tap deposit funding',
    unlocks:
      'Card/bank→USDC top-up and cash-out, plus one-tap deposit (Blink) into the connected wallet. ' +
      'Blank ⇒ the ramp + funding buttons stay hidden, payments still work.',
    impact: 'optional',
    origin: 'partner',
    where:
      "Ramp provider's dashboard for the server keys (never NEXT_PUBLIC_); the deposit provider's " +
      'console for the public app id. See lib/funding/blink.ts + lib/onramp/config.ts.',
    vars: [
      // Which hosted ramp runs is a server-only SELECTOR read at runtime (lib/onramp/
      // config.ts + offramp.ts) — no provider is hardcoded. Blank/unknown ⇒ that leg is a
      // clean no-op. Non-secret, but MUST reach the deployed env or the ramp stays dark
      // even with the server key set (the same drop that hid Blink).
      { name: 'ONRAMP_PROVIDER', purpose: 'On-ramp selector (coinbase|moonpay|stripe|circle|blink). Blank ⇒ off' },
      { name: 'OFFRAMP_PROVIDER', purpose: 'Off-ramp selector (moonpay|transak|coinbase). Blank ⇒ off' },
      { name: 'ONRAMP_SERVER_KEY', purpose: 'Signs the on-ramp session before redirect', secret: true },
      { name: 'OFFRAMP_SERVER_KEY', purpose: 'Signs the off-ramp session before redirect', secret: true },
      // Pay-in-any-token funding flow. NEXT_PUBLIC_FLOW_ENABLED is the client switch;
      // FLOW_PROVIDER is the server-only aggregator selector — both undeclared meant the
      // whole flow shipped dark even when configured. The app id + settle asset are public.
      { name: 'NEXT_PUBLIC_FLOW_ENABLED', purpose: 'Client switch for the pay-in-any-token flow. Blank ⇒ hidden' },
      { name: 'FLOW_PROVIDER', purpose: 'Aggregator selector (lifi|uniswap|oneinch|paraswap|0x). Blank ⇒ off' },
      { name: 'NEXT_PUBLIC_FLOW_APP_ID', purpose: 'Public app/api id from the swap provider' },
      { name: 'NEXT_PUBLIC_FLOW_SETTLE_ASSET', purpose: 'Asset the flow settles into (defaults to USDC)', hasDefault: true },
      { name: 'FLOW_SERVER_KEY', purpose: 'Signs the funding-flow session before redirect', secret: true },
      // One-tap deposit (Blink). BLINK_ENABLED is the server switch read at RUNTIME —
      // it MUST reach the running service (Secret Manager is for secrets; this is a
      // non-secret flag that goes in the plain runtime env). Without it the deposit
      // route returns not_configured even when the client shows the button. The two
      // NEXT_PUBLIC_ vars are inlined into the client bundle at build AND read by the
      // server at runtime, so they travel by both roads.
      {
        name: 'BLINK_ENABLED',
        purpose: 'Server switch for one-tap deposit ("true"/"1"/"yes"/"on"). Blank ⇒ OFF (fail-soft)',
      },
      {
        name: 'NEXT_PUBLIC_BLINK_APP_ID',
        purpose: 'Public app/client id the deposit widget starts with. Blank ⇒ the funding option is hidden',
      },
      { name: 'NEXT_PUBLIC_BLINK_TOKEN', purpose: 'Asset for one-tap deposit funding (defaults to USDC)', hasDefault: true },
      {
        name: 'NEXT_PUBLIC_BLINK_CHAIN_ID',
        purpose: "Default destination chain for the deposit (falls back to the app's default chain)",
        hasDefault: true,
      },
    ],
  },
  {
    id: 'x402-seller',
    label: 'x402 seller + gateway withdraw',
    unlocks: 'Selling nanopayment-gated calls and withdrawing the gateway balance.',
    impact: 'optional',
    origin: 'ours',
    where: 'A TESTNET key you generate. Never a wallet holding real funds.',
    vars: [
      // The PUBLIC payout wallet (the payTo in every 402 challenge). lib/x402.ts throws
      // "SELLER_ADDRESS is not set" without it, and the gateway balance/withdraw routes
      // report not_configured — so the whole x402 seller seam is dark on the live site
      // unless this reaches the deployed env. Non-secret (it is public in every challenge).
      { name: 'SELLER_ADDRESS', purpose: 'Public merchant payout EOA (the 402 payTo). Unset ⇒ x402 seller 503s' },
      { name: 'SELLER_PRIVATE_KEY', purpose: 'Testnet key the gateway withdraw route signs with', secret: true },
      { name: 'BUYER_PRIVATE_KEY', purpose: 'Testnet key that funds the gateway (npm run fund)', secret: true },
    ],
  },
  {
    id: 'internal-secrets',
    label: 'Internal route secrets (fail-CLOSED)',
    unlocks: 'Gates the internal POST routes. Unset ⇒ the route REFUSES every request — by design, not a bug.',
    impact: 'feature',
    origin: 'ours',
    where: 'Generate your own: `openssl rand -hex 32`. Shared between caller and route.',
    vars: [
      { name: 'PAYOUT_SWAP_INTERNAL_SECRET', purpose: 'Gates /api/payout-swap (503 when unset)', secret: true },
      { name: 'AP2_MANDATE_SECRET', purpose: 'Gates /api/ap2/mandate when set', secret: true },
    ],
  },
  {
    id: 'sealed-keystore',
    label: 'Sealed keystore (one encrypted file instead of N secrets)',
    unlocks: 'Ship every key as one encrypted `.env.sealed`; the deploy supplies only this passphrase.',
    impact: 'optional',
    origin: 'ours',
    where: 'You generate it: `openssl rand -base64 32`. Store it in a password manager — there is NO recovery.',
    vars: [
      {
        name: 'ACCESS0X1_ENV_PASSPHRASE',
        purpose: 'Unlocks .env.sealed at deploy time (npm run env:open)',
        secret: true,
      },
    ],
  },
  {
    id: 'telegram',
    label: 'Telegram payments bot (⏸ DEFERRED)',
    unlocks: 'Chat-native payment links. Deliberately dormant — unset means a clean 503 no-op.',
    impact: 'optional',
    origin: 'partner',
    where: 'DEFERRED — do not set up until @BotFather is verified. The real BotFather is FREE and never asks for payment.',
    vars: [
      { name: 'TELEGRAM_BOT_TOKEN', purpose: 'Bot token (blank ⇒ route is a no-op)', secret: true },
      { name: 'TELEGRAM_WEBHOOK_SECRET', purpose: 'Verifies the webhook caller is Telegram', secret: true },
    ],
  },
  {
    id: 'agent',
    label: 'Agent (x402 earn/spend)',
    unlocks: 'The autonomous MVP presentation loop: the agent earns and spends from its own bounded wallet.',
    impact: 'core',
    origin: 'ours',
    where: 'Set after the Dynamic wallet exists; caps/allowlist are yours to choose.',
    vars: [
      {
        name: 'AGENT_WALLET_ID',
        purpose: 'The agent MPC wallet id',
        required: true,
        mintedBy:
          'Dynamic, on the first authorized POST /api/agent/pay — the minted id comes back as the ' +
          '"agent" field of the 200 response (nothing is written to the server log). Leave BLANK now, ' +
          'then re-run this and paste it. A guessed id points the agent at a wallet that does not exist.',
      },
      { name: 'AGENT_DAILY_USD_CAP', purpose: 'Hard daily spend ceiling (0 blocks everything)', required: true },
      { name: 'AGENT_URL_ALLOWLIST', purpose: 'Comma-separated origins the agent may pay (deny-all when blank)', required: true },
      // The settlement chain + its USDC for the agent pay-any-token quote (route.ts reads
      // both; the quote is skipped when either is blank/invalid). Additive + fail-soft, but
      // dropping them at deploy silently returns no quote even when configured.
      { name: 'AGENT_QUOTE_CHAIN_ID', purpose: 'Settlement chain id for the agent any-token quote (blank ⇒ no quote)' },
      { name: 'AGENT_QUOTE_USDC', purpose: 'USDC address the any-token quote targets (blank ⇒ no quote)' },
      // Opt-in agent policy tighteners (off by default). Set in production to require a
      // World-verified human behind the agent and to enforce the per-session spend cap.
      { name: 'AGENT_REQUIRE_HUMAN', purpose: 'Require a World-verified human behind the agent (default off)', hasDefault: true },
      { name: 'AGENT_SESSION_CAP_ENFORCED', purpose: 'Enforce the per-session spend cap (default off)', hasDefault: true },
      // REQUIRED, not optional: /api/agent/pay FAILS CLOSED with 503 not_configured when this is
      // unset (route.ts callerAuthFailure). Labelling a secret that gates a money route "optional"
      // reads as "safe to skip" — it is safe, but it silently disables the agent pay path.
      {
        name: 'AGENT_INTERNAL_SECRET',
        purpose: 'Shared secret gating /api/agent/pay (unset ⇒ the route 503s)',
        required: true,
        secret: true,
      },
      // The dev-only bypass for the gate above. Present here so the doctor can SHOW it — an
      // operator who sets it in production has disabled caller auth on a route that spends USDC.
      {
        name: 'AGENT_ALLOW_INSECURE',
        purpose: 'LOCAL DEV ONLY — "true" bypasses the /api/agent/pay auth gate. Never set in production.',
        hasDefault: true,
      },
    ],
  },
  {
    id: 'state-anchor',
    label: 'Agent memory anchor (Walrus + provenance)',
    unlocks: 'earn → store → own: the agent’s memory content-addressed on Walrus and anchored on-chain.',
    impact: 'feature',
    origin: 'ours',
    where: 'A Sui testnet account for Walrus; the ProvenanceRegistry address from your broadcast records.',
    vars: [
      { name: 'AGENT_STATE_ANCHOR', purpose: 'Set "true" to switch the anchor loop on', required: true },
      { name: 'AGENT_ANCHOR_REGISTRY', purpose: 'ProvenanceRegistry address (from broadcast/)' },
      // The chain the anchor tx is submitted to. stateAnchor.ts returns null (no onchain
      // "own" leg) when this isn't a valid integer — so earn→store→own goes dark on-chain
      // (Walrus store still runs) if it's dropped at deploy.
      { name: 'AGENT_ANCHOR_CHAIN_ID', purpose: 'Chain id the anchor tx is submitted to (blank ⇒ no onchain anchor)' },
      { name: 'AGENT_ANCHOR_PRIVATE_KEY', purpose: 'Testnet key that submits the anchor tx', secret: true },
      { name: 'WALRUS_PUBLISHER', purpose: 'Walrus publisher base URL', hasDefault: true },
    ],
  },
  {
    id: 'deploy',
    label: 'Contract deploy + verify (Foundry)',
    unlocks: 'Verifying deployed contracts on every Etherscan-family explorer, in one key.',
    impact: 'core',
    origin: 'ours',
    // These are read by the Makefile + forge, which load the REPO-ROOT .env — not
    // web/.env.local. env:set writes them there so the deploy actually sees them.
    envFile: '.env',
    where: 'etherscan.io/myapikey (one V2 key verifies every explorer). DEPLOYER is the ADDRESS your `cast wallet import` keystore controls — the private key stays in the keystore, never here.',
    vars: [
      { name: 'ETHERSCAN_API_KEY', purpose: 'Etherscan V2 key — verifies contracts on all explorers', required: true, secret: true },
      { name: 'DEPLOYER', purpose: 'The public deployer address (--sender). NOT a private key.', required: true },
    ],
  },
  {
    id: 'rpc',
    label: 'RPC endpoints (QuickNode or any provider)',
    unlocks: 'Reliable per-chain reads/writes. Blank ⇒ public defaults (rate-limited).',
    impact: 'optional',
    origin: 'partner',
    where: 'quicknode.com (or any provider) — one HTTPS endpoint per chain.',
    vars: [
      { name: 'NEXT_PUBLIC_ARC_RPC_URL', purpose: 'Arc Testnet RPC (the settlement chain)', hasDefault: true },
      { name: 'NEXT_PUBLIC_ZIRCUIT_GARFIELD_RPC_URL', purpose: 'Zircuit Garfield RPC', hasDefault: true },
      { name: 'NEXT_PUBLIC_HEDERA_TESTNET_RPC_URL', purpose: 'Hedera Testnet (Hashio) RPC', hasDefault: true },
      { name: 'NEXT_PUBLIC_MAINNET_RPC_URL', purpose: 'Ethereum mainnet RPC — ENS reads only, never settlement', hasDefault: true },
      // The per-chain BROWSER override. The server-side `RPC_URL_<id>` form is read
      // through a computed key, so it is deliberately NOT declared here — the registry
      // holds literal names the code literally reads, and the coverage test enforces
      // exactly that. These two are literal, and they are the ones that matter for a
      // buyer, whose checkout reads happen in the browser where a computed key cannot
      // be inlined at all.
      { name: 'NEXT_PUBLIC_RPC_URL_11155111', purpose: 'Browser-readable RPC, Ethereum Sepolia — what a buyer\'s checkout actually uses', hasDefault: true },
      { name: 'NEXT_PUBLIC_RPC_URL_84532', purpose: 'Browser-readable RPC, Base Sepolia', hasDefault: true },
    ],
  },
] as const

/** Reading env without depending on a runtime — the doctor passes a parsed file. */
export type EnvLookup = (name: string) => string | undefined

/**
 * Scaffold markers — a value that is present but is obviously the placeholder
 * someone was meant to replace.
 *
 * WHY THIS EXISTS: `isSet` originally meant "non-empty", so a `.env.local` full
 * of `⟨PASTE YOUR KEY⟩` scaffolding reported every integration as ✅ CONFIGURED.
 * That is precisely the overclaim this repo forbids — a green check over a call
 * that will 401 at the worst possible moment. Real credentials are
 * high-entropy; they do not contain the word "paste".
 *
 * Deliberately tight, to avoid false positives on real values: only unmistakable
 * scaffold text, or a value wrapped in angle/bracket placeholder delimiters.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\bpaste\b/i,
  /\byour[_\s-]/i,
  /\bTODO\b/i,
  /\bchange[_\s-]?me\b/i,
  /\breplace[_\s-]?(me|this)\b/i,
  /^[<⟨[{].*[>⟩\]}]$/,
  /^x{4,}$/i,
  /\.\.\./,
]

/** True when a value is present but is clearly unreplaced scaffolding. */
export function isPlaceholder(value: string | undefined): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (!v) return false
  return PLACEHOLDER_PATTERNS.some((re) => re.test(v))
}

/**
 * Whether a value counts as SET: non-empty AND not obvious scaffolding.
 *
 * A placeholder is treated as UNSET on purpose. Reporting it as configured is
 * worse than reporting it missing — "missing" sends you to fill it in, while a
 * false green sends you on stage.
 */
export function isSet(value: string | undefined): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  return !isPlaceholder(value)
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
  /**
   * Vars holding unreplaced scaffolding (`⟨PASTE …⟩`). Called out separately
   * from "missing" because the failure feels different: the file LOOKS filled
   * in, so nobody goes back to it until a call 401s.
   */
  readonly placeholders: string[]
  /** True when every REQUIRED var is set (and none is a placeholder). */
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

  const placeholders = integration.vars.filter((v) => isPlaceholder(env(v.name))).map((v) => v.name)

  const anySet = integration.vars.some((v) => isSet(env(v.name)))
  const ready = missingRequired.length === 0 && (required.length > 0 || anySet)

  // A file full of scaffolding is `partial`, never `off` — "off" reads as
  // "nothing here yet", which would hide the fact that someone meant to fill it.
  const state: IntegrationState = ready ? 'configured' : anySet || placeholders.length ? 'partial' : 'off'
  return {
    id: integration.id,
    label: integration.label,
    impact: integration.impact,
    state,
    missingRequired,
    missingOptional,
    placeholders,
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
