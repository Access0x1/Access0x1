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
   * Whether USDC is the chain's native gas token (Arc). When `true`, a "no separate gas step" claim
   * is truthful only once verified end-to-end on that chain right now (doctrine guardrail #3 / law #4
   * truth-in-copy) — this flag alone is not a green light. When `false`, the chain charges a separate
   * gas token — `<PayButton>` must NOT claim "no gas" or a no-cost label.
   */
  readonly usdcIsNativeGas: boolean;
}

/**
 * The supported settlement chains. Arc-testnet (native-gas USDC), base-sepolia (the primary
 * EVM demo chain), and zksync-sepolia are the deployed chains; the chains below them (0G, Monad,
 * Berachain, Sei, MegaETH) are KNOWN-but-not-yet-deployed targets — config-only, deploy PENDING.
 * Arc is the only chain where USDC is the native gas token — see {@link ChainConfig.usdcIsNativeGas}
 * for what that does and does not license a UI to claim.
 *
 * DOCTRINE for the PENDING chains: their chainId + name are public facts; `usdc` is `undefined`
 * (never an invented address — law #4) and the host app supplies the router after the owner runs the
 * CREATE3 mirror deploy. The SDK never holds a router address (guardrail #7) regardless.
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

  // ── KNOWN, deploy PENDING (config-only) ───────────────────────────────────────────────────────
  // Chains the owner holds testnet gas on but Access0x1 is NOT deployed to yet. chainId + name are
  // facts; usdc is undefined until a Circle-issued token is booth-confirmed (never a mock/guess).
  // The "oracle situation" per chain governs whether the Router can price USD→token via Chainlink
  // directly or needs the swappable PriceOracleAdapter (Pyth). See docs/CHAIN-ADDRESSES.md.

  // 0G Galileo — native gas token "0G". No Chainlink/Pyth feed published → bare deploy until a
  // PriceOracleAdapter is wired (USD-priced payments off until then).
  zeroGGalileo: {
    name: '0G Galileo Testnet',
    chainId: 16602,
    usdc: undefined,
    usdcIsNativeGas: false,
  },
  // Monad Testnet — native gas "MON". Chainlink push ETH/USD + USDC/USD feeds ARE live here, so the
  // Router can price USD→token directly once deployed (no adapter needed); owner reads the exact
  // aggregator addresses from docs.chain.link at deploy.
  monadTestnet: {
    name: 'Monad Testnet',
    chainId: 10143,
    usdc: undefined,
    usdcIsNativeGas: false,
  },
  // Berachain Bepolia — native gas "BERA". On Chainlink's faucet list; no verified push price feed
  // yet → Pyth via PriceOracleAdapter (or a $1 USDC/USD mock) until a feed is confirmed.
  berachainBepolia: {
    name: 'Berachain Bepolia',
    chainId: 80069,
    usdc: undefined,
    usdcIsNativeGas: false,
  },
  // Sei Testnet (atlantic-2) — native gas "SEI". Pyth is the native oracle on Sei → prices via the
  // PriceOracleAdapter (Pyth), NOT Chainlink.
  seiTestnet: {
    name: 'Sei Testnet (atlantic-2)',
    chainId: 1328,
    usdc: undefined,
    usdcIsNativeGas: false,
  },
  // MegaETH Testnet — native gas "ETH". No Chainlink/Pyth feed confirmed → bare deploy until an
  // adapter is wired.
  megaethTestnet: {
    name: 'MegaETH Testnet',
    chainId: 6342,
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
