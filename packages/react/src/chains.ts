/**
 * @file Settlement-chain registry for the SDK.
 *
 * This mirrors the shared `web/lib/chains.ts` registry (owned by the `checkout-web` unit). Until that
 * file lands in the monorepo, the SDK keeps a small, self-contained copy so it has zero hard
 * dependency on the web app's build. When `web/lib/chains.ts` is published the two should be
 * reconciled to a single source — the shapes are intentionally identical.
 *
 * Hard rule (doctrine guardrail #7): the SDK NEVER hardcodes the router address into a hook or
 * component. The router address is always a required prop. This registry only holds chain metadata
 * and the well-known Circle USDC addresses — values that are not deployment-specific to Access0x1.
 *
 * USDC addresses below are the Circle-issued tokens on each testnet — never a mock ERC-20
 * (doctrine guardrail #2). The router address per chain is left intentionally absent: the host app
 * supplies it after running `registerMerchant` / reading the deploy broadcast.
 */

import type { Hex } from './types.js';

/** A settlement chain the SDK can drive a same-chain payment on. */
export interface ChainConfig {
  /** Human-readable chain name. */
  readonly name: string;
  /** EVM chain id. */
  readonly chainId: number;
  /** Circle-issued USDC on this chain (the default ERC-20 pay-in token). */
  readonly usdc: Hex;
  /**
   * Whether USDC is the chain's native gas token (Arc). When `true`, "no gas fee" copy is truthful
   * because Circle Paymaster covers gas (doctrine guardrail #3 / law #4 truth-in-copy). When `false`,
   * the chain charges a separate gas token — `<PayButton>` must NOT claim "free" or "no gas".
   */
  readonly usdcIsNativeGas: boolean;
}

/**
 * The supported settlement chains. Base Sepolia is the primary demo chain; Arc testnet is where the
 * gasless USDC story holds.
 */
export const CHAINS = {
  baseSepolia: {
    name: 'Base Sepolia',
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcIsNativeGas: false,
  },
  arbitrumSepolia: {
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    usdcIsNativeGas: false,
  },
} as const satisfies Record<string, ChainConfig>;

/** The canonical key set for {@link CHAINS}. */
export type ChainKey = keyof typeof CHAINS;

/**
 * Look up a {@link ChainConfig} by EVM chain id.
 *
 * @param chainId The connected wallet's chain id.
 * @returns The matching config, or `undefined` if the chain is not in the registry.
 */
export function getChainConfig(chainId: number): ChainConfig | undefined {
  return Object.values(CHAINS).find((c) => c.chainId === chainId);
}
