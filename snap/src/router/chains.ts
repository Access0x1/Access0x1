/**
 * Chain id → human-readable label, plus the block-explorer base URL used to
 * build payout receipt links.
 *
 * Only the chains Access0x1 targets at the hackathon are named; anything else
 * degrades gracefully to an "Unknown Chain" label so the panel never lies.
 */

/** Arc Testnet — Access0x1's primary settlement chain (native USDC). */
export const ARC_TESTNET = 5042002;
/** Base Sepolia. */
export const BASE_SEPOLIA = 84532;
/** zkSync Sepolia Testnet. */
export const ZKSYNC_SEPOLIA = 300;

const CHAIN_LABELS: Record<number, string> = {
  [ARC_TESTNET]: 'Arc Testnet',
  [BASE_SEPOLIA]: 'Base Sepolia',
  [ZKSYNC_SEPOLIA]: 'zkSync Sepolia',
};

/**
 * Resolve a human-readable label for an EVM chain id.
 *
 * @param chainId - Numeric EVM chain id.
 * @returns The chain's name, or `"Unknown Chain (id: <id>)"` for unrecognized ids.
 */
export function chainLabel(chainId: number): string {
  return CHAIN_LABELS[chainId] ?? `Unknown Chain (id: ${chainId})`;
}

/**
 * Block-explorer transaction-link base for a chain. Defaults to Arcscan testnet,
 * the chain the live demo settles on.
 *
 * @param chainId - Numeric EVM chain id.
 * @returns The explorer base URL ending in `/tx/`.
 */
export function explorerTxBase(chainId: number): string {
  switch (chainId) {
    case BASE_SEPOLIA:
      return 'https://sepolia.basescan.org/tx/';
    case ZKSYNC_SEPOLIA:
      return 'https://sepolia.explorer.zksync.io/tx/';
    case ARC_TESTNET:
    default:
      return 'https://testnet.arcscan.app/tx/';
  }
}
