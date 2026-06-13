/**
 * @file Settlement-chain registry for the SDK.
 *
 * This mirrors the canonical `web/lib/chains.ts` registry (owned by the `checkout-web` unit). The two
 * packages are published independently with no build-time link, so the SDK keeps a self-contained
 * copy with ZERO dependency on the web app's build — but the chain SET and the well-known addresses
 * are kept in lockstep with `web/lib/chains.ts` (the single source of truth). When you add or change
 * a chain there, update it here too.
 *
 * Hard rule (doctrine guardrail #7): the SDK NEVER hardcodes the router address into a hook or
 * component. The router address is always a required prop. This registry only holds chain metadata
 * and the well-known Circle USDC addresses — values that are not deployment-specific to Access0x1.
 *
 * USDC addresses below are the Circle-issued tokens on each testnet — never a mock ERC-20
 * (doctrine guardrail #2). Where an address is not yet booth-confirmed it is `undefined` (the same
 * "undefined until confirmed" doctrine the embed registry follows) — never an invented address. The
 * router address per chain is left intentionally absent: the host app supplies it after running
 * `registerMerchant` / reading the deploy broadcast.
 */

import type { Hex } from './types.js';

/** A settlement chain the SDK can drive a same-chain payment on. */
export interface ChainConfig {
  /** Human-readable chain name. */
  readonly name: string;
  /** EVM chain id. */
  readonly chainId: number;
  /**
   * Circle-issued USDC on this chain (the default ERC-20 pay-in token), or `undefined` where the
   * address is not yet booth-confirmed. Never a mock or invented address.
   */
  readonly usdc: Hex | undefined;
  /**
   * Whether USDC is the chain's native gas token (Arc). When `true`, "no gas fee" copy is truthful
   * because USDC pays gas directly (doctrine guardrail #3 / law #4 truth-in-copy). When `false`,
   * the chain charges a separate gas token — `<PayButton>` must NOT claim "free" or "no gas".
   */
  readonly usdcIsNativeGas: boolean;
}

/**
 * The supported settlement chains — the real union shipped by `web/lib/chains.ts`:
 * arc-testnet (the gasless-USDC lead), base-sepolia (the primary EVM demo chain), and
 * zksync-sepolia (a bridge target). Arc is the only chain where USDC is the native gas token, so it
 * is the only one for which "no gas fee" copy is truthful.
 */
export const CHAINS = {
  arcTestnet: {
    name: 'Arc Testnet',
    chainId: 5042002,
    // Arc native USDC is the system contract (18-decimal); USDC IS the gas token here.
    usdc: '0x3600000000000000000000000000000000000000',
    usdcIsNativeGas: true,
  },
  baseSepolia: {
    name: 'Base Sepolia',
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcIsNativeGas: false,
  },
  zksyncSepolia: {
    name: 'zkSync Sepolia',
    chainId: 300,
    // USDC on zkSync Sepolia is not yet booth-confirmed — host app supplies it via env.
    usdc: undefined,
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
