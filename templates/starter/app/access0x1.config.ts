/**
 * access0x1.config.ts — the single place this app reads its Access0x1 settings from.
 *
 * Doctrine / LAW #4 (truth in copy): NO contract address is hardcoded here. The router, USDC, and
 * feed addresses are read from `NEXT_PUBLIC_*` env vars (see .env.example) and are blank until YOU
 * deploy your own contracts (contracts/DEPLOY.md) or paste a router you trust. A missing router
 * address fails loudly at checkout rather than producing a silent wrong call.
 *
 * The only baked-in value is the public chain ID — a fact, not a secret.
 */

import type { Hex } from '@access0x1/react';

/** This project's settlement chain (chosen at scaffold time). */
export const CHAIN = {
  /** Human key from create-access0x1 (`arc` | `base` | `zksync`). */
  key: '{{CHAIN}}' as const,
  /** Human-readable name. */
  name: '{{CHAIN_NAME}}',
  /** EVM chain id — public fact. */
  id: {{CHAIN_ID}},
} as const;

/**
 * The deployed Access0x1Router on {@link CHAIN}. Read from the chain-scoped env var so it is never
 * hardcoded (doctrine guardrail #5/#7). The SDK's <PayButton> takes this as a required prop.
 *
 * Fill {{ROUTER_ENV}} in .env.local after you deploy (forge script DeployAll) or paste a router
 * address you trust. Throws if absent so a misconfig surfaces immediately.
 */
export function getRouterAddress(): Hex {
  const addr = process.env.{{ROUTER_ENV}};
  if (!addr) {
    throw new Error(
      'No router configured. Set {{ROUTER_ENV}} in .env.local — deploy your own ' +
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
  const addr = process.env.NEXT_PUBLIC_USDC_ADDRESS_{{CHAIN_ID}};
  return addr ? (addr as Hex) : undefined;
}

/**
 * The per-chain JSON-RPC endpoint. Falls back to a public endpoint for read-only quotes; override
 * with NEXT_PUBLIC_RPC_URL_<chainId> for a keyed/private RPC.
 */
export function getRpcUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_RPC_URL_{{CHAIN_ID}} || undefined;
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
  /** Circle USDC token address — NEXT_PUBLIC_USDC_ADDRESS_{{CHAIN_ID}}. */
  circleUsdc: 'NEXT_PUBLIC_USDC_ADDRESS_{{CHAIN_ID}}',
  /** Dynamic wallet auth — NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID. */
  dynamic: 'NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID',
  /** ENS / GitHat subname resolution — optional, NEXT_PUBLIC_ENS_*. */
  ens: 'NEXT_PUBLIC_ENS_* (optional)',
} as const;
