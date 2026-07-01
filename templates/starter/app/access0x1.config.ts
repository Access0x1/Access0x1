/**
 * access0x1.config.ts — the single place this app reads its Access0x1 settings from.
 *
 * Doctrine / LAW #4 (truth in copy): this file never INVENTS an address. The router DEFAULTS to the
 * CREATE3 "mirror" — a deterministic, already-deployed, source-verified address that is IDENTICAL on
 * every chain (computed from the salt, pinned in script/mirror-manifest.json) — but ONLY on chains
 * where it is actually deployed. That is a published fact, not a guess, so a fresh scaffold needs ZERO
 * env to pay on a mirrored chain. Override it any time with NEXT_PUBLIC_ROUTER_ADDRESS_<id> (your own
 * deploy, or a router you trust). On a chain where the mirror is NOT deployed yet, the router stays
 * unset and checkout fails loudly rather than calling an empty address.
 *
 * Baked-in values are public facts only: the chain ID and the verifiable CREATE3 mirror address.
 *
 * Scaffolded chain: {{CHAIN_NAME}} (chain id {{CHAIN_ID}}).
 *
 * HOW CHAIN VALUES ARE SET
 * ─────────────────────────
 * This file works out of the box after `degit` AND after the create-access0x1 CLI.
 *
 * - After `npx degit`: CHAIN_KEY defaults to '{{CHAIN}}' (unsubstituted); the CHAIN_DEFAULTS
 *   lookup table falls back to Arc Testnet (the lead chain). Edit CHAIN_KEY to 'base' or 'zksync'
 *   to target a different chain — the lookup table fills the rest automatically.
 *
 * - After the create-access0x1 CLI (`node packages/create-access0x1/bin/index.mjs … --chain base`,
 *   from a repo checkout — Access0x1 is git-distributed, not on npm): the CLI substitutes '{{CHAIN}}',
 *   '{{CHAIN_NAME}}', and '{{ROUTER_ENV}}' with the correct values. CHAIN_DEFAULTS is still present as
 *   a human-readable reference; the resolved values win.
 */

import type { Hex } from '@access0x1/react';

/**
 * Public chain metadata. All values are facts (chain IDs), never invented addresses.
 *
 * The `arc` / `base` / `zksync` keys are the deployed/lead targets. The keys below them (0G, Monad,
 * Berachain, Sei, MegaETH) are KNOWN-but-deploy-PENDING — pick one only after the owner runs the
 * CREATE3 mirror deploy on that chain and sets its NEXT_PUBLIC_ROUTER_ADDRESS_<id>. Until then the
 * router env is unset and checkout fails loudly (it never invents a router — LAW #4).
 */
const CHAIN_DEFAULTS = {
  arc:    { name: 'Arc Testnet',      id: 5042002, routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_5042002' },
  base:   { name: 'Base Sepolia',     id: 84532,   routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_84532'   },
  zksync: { name: 'zkSync Sepolia',   id: 300,     routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_300'     },
  // KNOWN, deploy PENDING — config only (chain IDs are public facts).
  zerog:  { name: '0G Galileo Testnet',      id: 16602, routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_16602' },
  monad:  { name: 'Monad Testnet',           id: 10143, routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_10143' },
  bera:   { name: 'Berachain Bepolia',       id: 80069, routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_80069' },
  sei:    { name: 'Sei Testnet (atlantic-2)', id: 1328,  routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_1328'  },
  megaeth:{ name: 'MegaETH Testnet',         id: 6342,  routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_6342'  },
} as const;
type ChainKey = keyof typeof CHAIN_DEFAULTS;

// create-access0x1 substitutes '{{CHAIN}}' with the chosen chain key.
// After plain degit the token stays literal; the fallback below catches it.
const _rawKey = '{{CHAIN}}';
const CHAIN_KEY: ChainKey = (_rawKey in CHAIN_DEFAULTS ? _rawKey : 'arc') as ChainKey;
const _defaults = CHAIN_DEFAULTS[CHAIN_KEY];

// create-access0x1 also substitutes '{{CHAIN_NAME}}' and '{{ROUTER_ENV}}' in the strings below.
// If unsubstituted (degit path), the lookup table values above are used instead — same result.
const _scaffoldName = '{{CHAIN_NAME}}';
const _scaffoldEnv  = '{{ROUTER_ENV}}';
const CHAIN_NAME_STR   = _scaffoldName.startsWith('{{') ? _defaults.name     : _scaffoldName;
const ROUTER_ENV_KEY   = _scaffoldEnv.startsWith('{{')  ? _defaults.routerEnv : _scaffoldEnv;

/** This project's settlement chain (chosen at scaffold time). */
export const CHAIN = {
  /** Human key (`arc` | `base` | `zksync`). */
  key: CHAIN_KEY,
  /** Human-readable name. */
  name: CHAIN_NAME_STR,
  /** EVM chain id — public fact. */
  id: _defaults.id,
} as const;

/**
 * The CREATE3 "mirror" Access0x1Router — the SAME address on EVERY chain, because it is deployed
 * through the CreateX factory at a salt-derived address (see script/mirror-manifest.json). It is NOT
 * invented here: it is the published, source-verified proxy. Used as the zero-env DEFAULT router on
 * chains where the mirror is actually deployed (below); env overrides it; non-mirrored chains get no
 * default and fail loudly.
 */
const MIRROR_ROUTER = '0xe92244e3368561faf21648146511DeDE3a475EB5' as Hex;

/**
 * Chain IDs where {@link MIRROR_ROUTER} is actually deployed + source-verified, so defaulting to it is
 * truthful. A chain NOT in this set has no router default — set its env after the owner runs the
 * CREATE3 mirror deploy there, else checkout fails loudly (never points at an empty address — LAW #4).
 */
const MIRROR_DEPLOYED_CHAIN_IDS = new Set<number>([
  5042002,   // Arc Testnet
  84532,     // Base Sepolia
  11155111,  // Ethereum Sepolia
  11155420,  // Optimism Sepolia
  43113,     // Avalanche Fuji
  46630,     // Robinhood Testnet
  421614,    // Arbitrum Sepolia
  11142220,  // Celo Sepolia
]);

// Next.js inlines NEXT_PUBLIC_* into CLIENT bundles ONLY for STATIC member access
// (process.env.NEXT_PUBLIC_FOO). A computed process.env[key] is NOT inlined and reads as `undefined`
// in the browser — which silently hid the router/USDC/RPC overrides. List the chain-scoped vars
// statically here so their values ARE the inlined statics; the getters below index this plain object.
const STATIC_ENV: Record<string, string | undefined> = {
  NEXT_PUBLIC_ROUTER_ADDRESS_5042002: process.env.NEXT_PUBLIC_ROUTER_ADDRESS_5042002,
  NEXT_PUBLIC_ROUTER_ADDRESS_84532:   process.env.NEXT_PUBLIC_ROUTER_ADDRESS_84532,
  NEXT_PUBLIC_ROUTER_ADDRESS_300:     process.env.NEXT_PUBLIC_ROUTER_ADDRESS_300,
  NEXT_PUBLIC_ROUTER_ADDRESS_16602:   process.env.NEXT_PUBLIC_ROUTER_ADDRESS_16602,
  NEXT_PUBLIC_ROUTER_ADDRESS_10143:   process.env.NEXT_PUBLIC_ROUTER_ADDRESS_10143,
  NEXT_PUBLIC_ROUTER_ADDRESS_80069:   process.env.NEXT_PUBLIC_ROUTER_ADDRESS_80069,
  NEXT_PUBLIC_ROUTER_ADDRESS_1328:    process.env.NEXT_PUBLIC_ROUTER_ADDRESS_1328,
  NEXT_PUBLIC_ROUTER_ADDRESS_6342:    process.env.NEXT_PUBLIC_ROUTER_ADDRESS_6342,
  NEXT_PUBLIC_USDC_ADDRESS_5042002:   process.env.NEXT_PUBLIC_USDC_ADDRESS_5042002,
  NEXT_PUBLIC_USDC_ADDRESS_84532:     process.env.NEXT_PUBLIC_USDC_ADDRESS_84532,
  NEXT_PUBLIC_USDC_ADDRESS_300:       process.env.NEXT_PUBLIC_USDC_ADDRESS_300,
  NEXT_PUBLIC_USDC_ADDRESS_16602:     process.env.NEXT_PUBLIC_USDC_ADDRESS_16602,
  NEXT_PUBLIC_USDC_ADDRESS_10143:     process.env.NEXT_PUBLIC_USDC_ADDRESS_10143,
  NEXT_PUBLIC_USDC_ADDRESS_80069:     process.env.NEXT_PUBLIC_USDC_ADDRESS_80069,
  NEXT_PUBLIC_USDC_ADDRESS_1328:      process.env.NEXT_PUBLIC_USDC_ADDRESS_1328,
  NEXT_PUBLIC_USDC_ADDRESS_6342:      process.env.NEXT_PUBLIC_USDC_ADDRESS_6342,
  NEXT_PUBLIC_RPC_URL_5042002:        process.env.NEXT_PUBLIC_RPC_URL_5042002,
  NEXT_PUBLIC_RPC_URL_84532:          process.env.NEXT_PUBLIC_RPC_URL_84532,
  NEXT_PUBLIC_RPC_URL_300:            process.env.NEXT_PUBLIC_RPC_URL_300,
  NEXT_PUBLIC_RPC_URL_16602:          process.env.NEXT_PUBLIC_RPC_URL_16602,
  NEXT_PUBLIC_RPC_URL_10143:          process.env.NEXT_PUBLIC_RPC_URL_10143,
  NEXT_PUBLIC_RPC_URL_80069:          process.env.NEXT_PUBLIC_RPC_URL_80069,
  NEXT_PUBLIC_RPC_URL_1328:           process.env.NEXT_PUBLIC_RPC_URL_1328,
  NEXT_PUBLIC_RPC_URL_6342:           process.env.NEXT_PUBLIC_RPC_URL_6342,
};

/**
 * The Access0x1Router on {@link CHAIN}. Resolution order:
 *   1. NEXT_PUBLIC_ROUTER_ADDRESS_<id> if set (your own deploy / a router you trust) — always wins.
 *   2. else the CREATE3 {@link MIRROR_ROUTER} default, IF the mirror is deployed on this chain.
 *   3. else throw — never point at an empty address (LAW #4).
 * The SDK's <PayButton> takes this as a required prop; this resolves the value to pass.
 */
export function getRouterAddress(): Hex {
  const override = STATIC_ENV[ROUTER_ENV_KEY];
  if (override) return override as Hex;
  if (MIRROR_DEPLOYED_CHAIN_IDS.has(CHAIN.id)) return MIRROR_ROUTER;
  throw new Error(
    `No router configured for ${CHAIN.name} (chain ${CHAIN.id}). The CREATE3 mirror is not deployed ` +
      `there yet — set ${ROUTER_ENV_KEY} in .env.local after you run the mirror deploy, or paste a ` +
      'router address you trust. Never invent one (LAW #4).',
  );
}

/**
 * The allowlisted USDC token on {@link CHAIN}, or `undefined` if not yet configured. When undefined,
 * the checkout pays in the chain's native token (address(0)); when set, it pays in USDC.
 *
 * On Arc, USDC IS the native gas token — leave this blank to pay natively in USDC.
 */
export function getUsdcAddress(): Hex | undefined {
  const addr = STATIC_ENV[`NEXT_PUBLIC_USDC_ADDRESS_${CHAIN.id}`];
  return addr ? (addr as Hex) : undefined;
}

/**
 * The per-chain JSON-RPC endpoint. Falls back to a public endpoint for read-only quotes; override
 * with NEXT_PUBLIC_RPC_URL_<chainId> for a keyed/private RPC.
 */
export function getRpcUrl(): string | undefined {
  return STATIC_ENV[`NEXT_PUBLIC_RPC_URL_${CHAIN.id}`] || undefined;
}

/**
 * Optional Dynamic environment id (hosted wallet auth/signing). Blank by default; the bundled
 * checkout uses a plain injected wallet (window.ethereum) so it boots with zero booth credentials.
 * Wire Dynamic in your own provider once you have an env id.
 */
export function getDynamicEnvId(): string | undefined {
  return process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID || undefined;
}

/** Wallet/auth sponsor for the checkout. Vanilla default = injected (window.ethereum, zero creds). */
export type WalletProvider = 'injected' | 'dynamic' | 'privy' | 'wagmi';

/**
 * Which wallet/auth sponsor to use — the integrator's CHOICE (NEXT_PUBLIC_WALLET_PROVIDER):
 *   'injected' (default) — MetaMask/Rabby/etc, zero credentials
 *   'dynamic'            — Dynamic hosted wallets (set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID)
 *   'privy'              — Privy embedded wallets (set NEXT_PUBLIC_PRIVY_APP_ID)
 *   'wagmi'              — wagmi / WalletConnect (wire your own wagmi config)
 * The SDK is auth-agnostic: a non-injected provider just hands the scaffold a viem wallet client
 * (see app/access0x1-client.ts), so switching providers never touches the checkout component.
 */
export function getWalletProvider(): WalletProvider {
  const allowed: readonly WalletProvider[] = ['injected', 'dynamic', 'privy', 'wagmi'];
  const p = (process.env.NEXT_PUBLIC_WALLET_PROVIDER || 'injected').toLowerCase() as WalletProvider;
  return allowed.includes(p) ? p : 'injected';
}

/** Privy app id (embedded wallets / private login). Blank = Privy off. */
export function getPrivyAppId(): string | undefined {
  return process.env.NEXT_PUBLIC_PRIVY_APP_ID || undefined;
}

/**
 * EARNINGS PRIVACY (off by default). Public chains expose every settlement, so a merchant's revenue is
 * visible to competitors. When enabled, the checkout routes through the private-settlement path so the
 * merchant's earnings are shielded. The private rail is host-provided (the reference app uses Unlink). Vanilla settlements stay public + verifiable.
 */
export function isEarningsPrivacyEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EARNINGS_PRIVACY === 'true';
}

/**
 * Social logins to surface — a clean, Google-NATIVE sign-in (and others) powered by the wallet
 * provider (Dynamic or Privy) underneath. Comma-separated NEXT_PUBLIC_SOCIAL_LOGINS (e.g. "google" or
 * "google,apple"); empty = wallet-only. The provider must have the matching social connector enabled
 * in its dashboard — the SDK itself stays auth-agnostic, so the buyer sees "Continue with Google"
 * while Dynamic/Privy mints the wallet behind it.
 */
export function getSocialLogins(): string[] {
  return (process.env.NEXT_PUBLIC_SOCIAL_LOGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * ENS pay-to-name — OPTIONAL, OFF by default. When enabled, the checkout shows an extra field where a
 * human name (e.g. `alice.eth`) is resolved to a recipient/payout address ON THIS SETTLEMENT CHAIN
 * before paying. Enabled implicitly by setting any NEXT_PUBLIC_ENS_* knob, or explicitly with
 * NEXT_PUBLIC_ENS_PAY_TO_NAME=true. Blank/unset ⇒ the field is hidden and checkout is byte-identical
 * to before (the merchant's on-chain payout is used, untouched).
 *
 * Resolution NEVER invents an address (LAW #4) and NEVER silently falls back to a mainnet address on an
 * L2 (LAW #5): a name that doesn't resolve on this chain surfaces a clear error and blocks pay.
 */
export function isEnsPayToNameEnabled(): boolean {
  if ((process.env.NEXT_PUBLIC_ENS_PAY_TO_NAME || '').toLowerCase() === 'true') return true;
  // Setting either ENS knob is taken as opt-in (matches the "input your difference" pattern).
  return Boolean(getEnsResolverOverride() || getMainnetRpcUrl());
}

/**
 * ENS Universal Resolver OVERRIDE (NEXT_PUBLIC_ENS_RESOLVER). Blank ⇒ viem targets the canonical
 * Universal Resolver by ENS name (no address baked in here — LAW #4). Set this only to point at a
 * resolver you have confirmed on Etherscan for the network you read ENS from.
 */
export function getEnsResolverOverride(): Hex | undefined {
  const raw = (process.env.NEXT_PUBLIC_ENS_RESOLVER || '').trim();
  return raw ? (raw as Hex) : undefined;
}

/**
 * Optional Ethereum Mainnet RPC for ENS resolution (NEXT_PUBLIC_MAINNET_RPC_URL). ENS lives on mainnet
 * even in ENSv2, so resolution always runs there (never on the settlement chain). Blank ⇒ viem's public
 * transport. This RPC is used ONLY for the read-only resolution call — never for settlement.
 */
export function getMainnetRpcUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_MAINNET_RPC_URL || undefined;
}

/**
 * The ONE place to "input your differences" — every sponsor seam this rail supports, with its env knob
 * and vanilla default. Access0x1 is sponsor-AGNOSTIC: each is an explicit CHOICE, never hardwired.
 * Values are env-var NAMES / option lists (never baked addresses — LAW #4).
 */
export const INTEGRATION_SEAMS = {
  // ── Pricing / token ───────────────────────────────────────────────────────────────────────
  /** Oracle: Chainlink (default) or Pyth via the swappable PriceOracleAdapter — wired ON-CHAIN at deploy. */
  oracle: 'Chainlink | Pyth — contracts/script/HelperConfig.s.sol at deploy',
  /** Stablecoin: Circle USDC (default) or any allowlisted ERC-20 — NEXT_PUBLIC_USDC_ADDRESS_<chainId>. */
  token: `Circle USDC | any ERC-20 — NEXT_PUBLIC_USDC_ADDRESS_${CHAIN.id}`,
  // ── Wallet / auth (pick ONE; vanilla = injected) ────────────────────────────────────────────
  /** Wallet provider — NEXT_PUBLIC_WALLET_PROVIDER: injected (default) | dynamic | privy | wagmi. */
  wallet: 'NEXT_PUBLIC_WALLET_PROVIDER = injected | dynamic | privy | wagmi',
  /** Dynamic hosted wallets — NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID. */
  dynamic: 'NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID',
  /** Privy embedded wallets — NEXT_PUBLIC_PRIVY_APP_ID. */
  privy: 'NEXT_PUBLIC_PRIVY_APP_ID',
  /** Social login — Google-native (and others) via the wallet provider (Dynamic/Privy). NEXT_PUBLIC_SOCIAL_LOGINS=google. */
  google: 'NEXT_PUBLIC_SOCIAL_LOGINS=google (Google-native sign-in via Dynamic/Privy)',
  // ── Privacy ─────────────────────────────────────────────────────────────────────────────────
  /** Earnings privacy — hide merchant revenue from competitors. NEXT_PUBLIC_EARNINGS_PRIVACY=true (host-provided rail, e.g. Unlink). */
  earningsPrivacy: 'NEXT_PUBLIC_EARNINGS_PRIVACY=true (host-provided private rail, e.g. Unlink)',
  // ── Identity ────────────────────────────────────────────────────────────────────────────────
  /** ENS pay-to-name — optional, OFF by default. NEXT_PUBLIC_ENS_PAY_TO_NAME=true + NEXT_PUBLIC_ENS_RESOLVER (resolver override) + NEXT_PUBLIC_MAINNET_RPC_URL. */
  ens: 'NEXT_PUBLIC_ENS_PAY_TO_NAME=true + NEXT_PUBLIC_ENS_RESOLVER + NEXT_PUBLIC_MAINNET_RPC_URL (optional)',
  /** World ID human verification — optional, off when unset. NEXT_PUBLIC_WORLD_APP_ID + WORLD_RP_ID. */
  worldId: 'NEXT_PUBLIC_WORLD_APP_ID + WORLD_RP_ID (optional)',
  // ── Gas / fiat ──────────────────────────────────────────────────────────────────────────────
  /** Gas sponsorship (ERC-7677 paymaster) — optional. PAYMASTER_ENABLED + NEXT_PUBLIC_PAYMASTER_URL. */
  paymaster: 'PAYMASTER_ENABLED + NEXT_PUBLIC_PAYMASTER_URL (optional, ERC-7677)',
  /** Fiat on-ramp — optional. ONRAMP_PROVIDER (coinbase|moonpay|stripe|circle|transak) + NEXT_PUBLIC_ONRAMP_BASE_URL. */
  onramp: 'ONRAMP_PROVIDER + NEXT_PUBLIC_ONRAMP_BASE_URL (optional)',
  // ── Agents / advanced ───────────────────────────────────────────────────────────────────────
  /** x402 + SessionGrant agent payments — optional, off the main money path. Per-chain NEXT_PUBLIC_X402_*. */
  x402: 'NEXT_PUBLIC_X402_* per chain (optional, agent payments)',
  /** Flow — pay in any token, settle USDC. Optional. NEXT_PUBLIC_FLOW_ENABLED. */
  flow: 'NEXT_PUBLIC_FLOW_ENABLED (optional, any-token → USDC)',
} as const;
