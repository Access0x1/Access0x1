/**
 * embedConfig.ts — typed chain registry for the One-Tag Checkout embed.
 *
 * This is the SERVER-side / build-side source of truth that mirrors the
 * `CHAIN_DEFAULTS` map baked into `public/embed.js`. The embed itself is a
 * zero-dependency vanilla IIFE (it cannot import this module), so this file
 * exists for two reasons:
 *
 *   1. It gives the rest of the Next.js app a typed, single-source view of the
 *      same chain registry the embed uses (checkout page, API routes, tests).
 *   2. It centralizes the `NEXT_PUBLIC_*` env-var names that
 *      `scripts/replace-embed-addrs.js` substitutes into `embed.js` at build
 *      time — so the placeholder tokens and the env-var names never drift apart.
 *
 * DOCTRINE: every router/USDC address is `undefined` until provided via an
 * env var. No address is hardcoded from memory — all addresses are
 * booth-confirmed and wired through `NEXT_PUBLIC_*` (SPEC.md + CHAINS.md law).
 */

/** A single supported chain's embed configuration. */
export interface ChainEmbedConfig {
  /** EVM chain id (e.g. 5042002 = Arc testnet). */
  readonly chainId: number;
  /** Human-readable chain name (for logs / UI, never sent on-chain). */
  readonly name: string;
  /** Public JSON-RPC endpoint — no API key required (eth_call only). */
  readonly rpc: string;
  /** Access0x1Router address on this chain, or undefined until deployed. */
  readonly router: string | undefined;
  /** Display USDC token address on this chain, or undefined until confirmed. */
  readonly usdc: string | undefined;
  /** USDC decimals on this chain (Arc native USDC = 18; ERC-20 USDC = 6). */
  readonly usdcDecimals: number;
}

/**
 * The placeholder tokens that live in `public/embed.js` and the
 * `NEXT_PUBLIC_*` env var each one is replaced from. Consumed by
 * `scripts/replace-embed-addrs.js`. Order is irrelevant; the key is the
 * placeholder token, the value is the env-var name.
 *
 * Until the router is deployed (and the env var set), the embed serves
 * correctly with the placeholder still present: the quote `eth_call` is
 * skipped / fails gracefully and the button shows the USD-only label.
 */
export const EMBED_ADDRESS_PLACEHOLDERS: Readonly<Record<string, string>> = {
  __ROUTER_ADDRESS__: 'NEXT_PUBLIC_ROUTER_ARC',
  __ARC_USDC_ADDRESS__: 'NEXT_PUBLIC_USDC_ARC',
  __BASE_SEPOLIA_ROUTER_ADDRESS__: 'NEXT_PUBLIC_ROUTER_BASE_SEPOLIA',
  __BASE_SEPOLIA_USDC_ADDRESS__: 'NEXT_PUBLIC_USDC_BASE_SEPOLIA',
  __ZKSYNC_SEPOLIA_ROUTER_ADDRESS__: 'NEXT_PUBLIC_ROUTER_ZKSYNC_SEPOLIA',
  __ZKSYNC_SEPOLIA_USDC_ADDRESS__: 'NEXT_PUBLIC_USDC_ZKSYNC_SEPOLIA',
} as const;

/** Arc testnet chain id — the embed's default chain. */
export const DEFAULT_CHAIN_ID = 5042002;

/**
 * Build the typed chain registry from the current environment. Addresses come
 * from `NEXT_PUBLIC_*` env vars and are `undefined` when unset (never a
 * hardcoded default). Pass an explicit env map for tests; defaults to
 * `process.env`.
 *
 * @param env - the environment to read `NEXT_PUBLIC_*` addresses from.
 * @returns a frozen `chainId -> ChainEmbedConfig` map.
 */
export function buildEmbedConfig(
  env: Record<string, string | undefined> = process.env,
): Readonly<Record<number, ChainEmbedConfig>> {
  return Object.freeze({
    5042002: {
      chainId: 5042002,
      name: 'Arc testnet',
      rpc: 'https://rpc.testnet.arc.network',
      router: env.NEXT_PUBLIC_ROUTER_ARC,
      usdc: env.NEXT_PUBLIC_USDC_ARC,
      usdcDecimals: 18, // Arc native USDC is 18-dec (confirm at booth)
    },
    84532: {
      chainId: 84532,
      name: 'Base Sepolia',
      rpc: 'https://sepolia.base.org',
      router: env.NEXT_PUBLIC_ROUTER_BASE_SEPOLIA,
      usdc: env.NEXT_PUBLIC_USDC_BASE_SEPOLIA,
      usdcDecimals: 6,
    },
    300: {
      chainId: 300,
      name: 'zkSync Sepolia',
      rpc: 'https://sepolia.era.zksync.dev',
      router: env.NEXT_PUBLIC_ROUTER_ZKSYNC_SEPOLIA,
      usdc: env.NEXT_PUBLIC_USDC_ZKSYNC_SEPOLIA,
      usdcDecimals: 6,
    },
  });
}
