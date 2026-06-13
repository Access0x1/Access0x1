import { type Chain, mainnet } from 'viem/chains';

/**
 * Explicit chain objects for chains that may be absent from `viem/chains`.
 *
 * Arc (Circle's settlement chain) and zkSync Sepolia are defined here so the
 * SDK never depends on a hard-coded chain id buried in `viem/chains` and never
 * hard-codes a coinType. The coinType is ALWAYS derived from `chain.id` via
 * {@link toCoinType} (ENSIP-11), never stored as a literal.
 *
 * @see https://docs.ens.domains/ensip/11 (ENSIP-11 coinType derivation)
 */

/**
 * Arc testnet. Chain id `5042002`.
 *
 * Booth-confirm rule (doctrine #8): this id is used for `toCoinType` derivation
 * only. Do not claim Arc ENS resolution works end-to-end until a live
 * USDC-on-Arc payment with an ENS-resolved payout has been verified at the
 * Arc booth.
 */
export const arcTestnet: Chain = {
  id: 5_042_002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.arc-testnet.circle.com'] },
  },
  testnet: true,
};

/**
 * zkSync Sepolia testnet. Chain id `300`.
 */
export const zkSyncSepoliaTestnet: Chain = {
  id: 300,
  name: 'zkSync Sepolia Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://sepolia.era.zksync.dev'] },
  },
  testnet: true,
};

/**
 * Re-export `mainnet` so callers resolving ENS always have the canonical
 * Ethereum Mainnet chain object — ENS lives on mainnet even in ENSv2.
 */
export { mainnet };
