/**
 * access0x1.config.ts — the single place this app reads its Access0x1 settings from.
 *
 * Doctrine / LAW #4 (truth in copy): NO contract address is hardcoded here. The router, USDC, and
 * feed addresses are read from `NEXT_PUBLIC_*` env vars (see .env.example) and are blank until YOU
 * deploy your own contracts (contracts/DEPLOY.md) or paste a router you trust. A missing router
 * address fails loudly at checkout rather than producing a silent wrong call.
 *
 * The only baked-in value is the public chain ID — a fact, not a secret.
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

/** Public chain metadata. All values are facts (chain IDs), never invented addresses. */
const CHAIN_DEFAULTS = {
  arc:    { name: 'Arc Testnet',      id: 5042002, routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_5042002' },
  base:   { name: 'Base Sepolia',     id: 84532,   routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_84532'   },
  zksync: { name: 'zkSync Sepolia',   id: 300,     routerEnv: 'NEXT_PUBLIC_ROUTER_ADDRESS_300'     },
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
 * The deployed Access0x1Router on {@link CHAIN}. Read from the chain-scoped env var so it is never
 * hardcoded. The SDK's <PayButton> takes this as a required prop.
 *
 * Fill the env var in .env.local after you deploy (forge script DeployAll) or paste a router
 * address you trust. Throws if absent so a misconfig surfaces immediately.
 */
export function getRouterAddress(): Hex {
  const addr = process.env[ROUTER_ENV_KEY];
  if (!addr) {
    throw new Error(
      `No router configured. Set ${ROUTER_ENV_KEY} in .env.local — deploy your own ` +
        '(contracts/DEPLOY.md) or paste a router address you trust. Never invent one (LAW #4).',
    );
  }
  return addr as Hex;
}

/**
 * The allowlisted USDC token on {@link CHAIN}, or `undefined` if not yet configured. When undefined,
 * the checkout pays in the chain's native token (address(0)); when set, it pays in USDC.
 *
 * On Arc, USDC IS the native gas token — leave this blank to pay natively in USDC.
 */
export function getUsdcAddress(): Hex | undefined {
  const addr = process.env[`NEXT_PUBLIC_USDC_ADDRESS_${CHAIN.id}`];
  return addr ? (addr as Hex) : undefined;
}

/**
 * The per-chain JSON-RPC endpoint. Falls back to a public endpoint for read-only quotes; override
 * with NEXT_PUBLIC_RPC_URL_<chainId> for a keyed/private RPC.
 */
export function getRpcUrl(): string | undefined {
  return process.env[`NEXT_PUBLIC_RPC_URL_${CHAIN.id}`] || undefined;
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
 * Sponsor seams (filled at the booth / from your own infra). These are intentionally NOT addresses
 * baked into source — they are read from env where used. Documented here so you know every seam.
 */
export const SPONSOR_SEAMS = {
  /** Chainlink price feeds are configured ON-CHAIN at deploy time (HelperConfig), not in the app. */
  chainlinkFeeds: 'set via contracts/script/HelperConfig.s.sol at deploy',
  /** Circle USDC token address — NEXT_PUBLIC_USDC_ADDRESS_<chainId>. */
  circleUsdc: `NEXT_PUBLIC_USDC_ADDRESS_${CHAIN.id}`,
  /** Dynamic wallet auth — NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID. */
  dynamic: 'NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID',
  /** ENS subname resolution — optional, NEXT_PUBLIC_ENS_*. */
  ens: 'NEXT_PUBLIC_ENS_* (optional)',
} as const;
