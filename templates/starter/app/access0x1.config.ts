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
 * This file works out of the box after `degit` AND after `npm create access0x1`.
 *
 * - After `npx degit`: CHAIN_KEY defaults to '{{CHAIN}}' (unsubstituted); the CHAIN_DEFAULTS
 *   lookup table falls back to Arc Testnet (the lead chain). Edit CHAIN_KEY to 'base' or 'zksync'
 *   to target a different chain — the lookup table fills the rest automatically.
 *
 * - After `npm create access0x1 --chain base` (or `arc`/`zksync`): the create-access0x1 CLI
 *   substitutes '{{CHAIN}}', '{{CHAIN_NAME}}', and '{{ROUTER_ENV}}' with the correct values.
 *   CHAIN_DEFAULTS is still present as a human-readable reference; the resolved values win.
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

/**
 * Integration seams (filled from official docs / from your own infra). These are intentionally NOT addresses
 * baked into source — they are read from env where used. Documented here so you know every seam.
 */
export const INTEGRATION_SEAMS = {
  /** Chainlink price feeds are configured ON-CHAIN at deploy time (HelperConfig), not in the app. */
  chainlinkFeeds: 'set via contracts/script/HelperConfig.s.sol at deploy',
  /** Circle USDC token address — NEXT_PUBLIC_USDC_ADDRESS_<chainId>. */
  circleUsdc: `NEXT_PUBLIC_USDC_ADDRESS_${CHAIN.id}`,
  /** Dynamic wallet auth — NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID. */
  dynamic: 'NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID',
  /** ENS subname resolution — optional, NEXT_PUBLIC_ENS_*. */
  ens: 'NEXT_PUBLIC_ENS_* (optional)',
} as const;
