import type { Address } from 'viem'

/**
 * @file tokens.ts — the canonical SUPPORTED PAY-TOKEN set for the hosted checkout.
 *
 * A buyer may pay in ANY allowlisted coin (the Router supports `payToken(any
 * allowlisted token)` + `setTokenAllowed` + `setPriceFeed`); each is USD-priced
 * via its own Chainlink <token>/USD feed, read on-chain by `quote()`. This module
 * is the SINGLE source of truth for WHICH coins the picker offers and HOW to
 * resolve each one's address + feed on a given chain.
 *
 * ENV-DRIVEN, NEVER INVENTED (doctrine guardrail #5 — no address from memory):
 * a token's on-chain address and its Chainlink feed are read from
 * `NEXT_PUBLIC_TOKEN_<SYM>_<chainId>` and `NEXT_PUBLIC_TOKEN_<SYM>_FEED_<chainId>`.
 * Until BOTH are configured for the active chain, the token is `undefined`
 * (address) and is shown DISABLED in the picker with an honest "not available on
 * this chain" note — we never guess an address or render a coin we can't price.
 *
 * USDC is the DEFAULT and a special case: its address already lives in
 * `chains.ts` (`getUsdcAddress` / `NEXT_PUBLIC_USDC_ADDRESS_<chainId>`) and its
 * feed is wired by `setPriceFeed(usdc, ...)` at deploy. The picker resolves USDC
 * through that existing seam so we never duplicate the USDC address var.
 *
 * Symbol / name / decimals here are DISPLAY metadata only — the money path reads
 * `decimals()` and the feed on-chain in-tx; this table never reaches settlement.
 */

/** The pay-token symbols the checkout offers. USDC is the default; the rest are opt-in per chain. */
export type PayTokenSymbol = 'USDC' | 'WETH' | 'LINK' | 'UNI' | 'ENS' | 'DAI' | 'WBTC'

/** Static (chain-independent) metadata for a supported pay token. */
export interface PayTokenMeta {
  /** Ticker shown in the picker (e.g. "LINK"). Also the env-var infix. */
  symbol: PayTokenSymbol
  /** Human-readable name shown beside the ticker (e.g. "Chainlink"). */
  name: string
  /** The token's ERC-20 decimals — DISPLAY only (the contract reads `decimals()` in-tx). */
  decimals: number
  /**
   * The `NEXT_PUBLIC_*` env var that holds this token's ERC-20 address on a given
   * chain. A FUNCTION of chainId so a missing config surfaces as `undefined`, never
   * a guessed address. For USDC this returns the existing `NEXT_PUBLIC_USDC_ADDRESS_*`
   * var (no duplicate var); every other token uses `NEXT_PUBLIC_TOKEN_<SYM>_<chainId>`.
   */
  addressEnv: (chainId: number) => string
  /**
   * The `NEXT_PUBLIC_*` env var that holds this token's Chainlink <token>/USD feed
   * address on a given chain — `NEXT_PUBLIC_TOKEN_<SYM>_FEED_<chainId>` (USDC reuses
   * `NEXT_PUBLIC_USDC_USD_FEED_<chainId>`). The feed is wired into the Router at
   * deploy; this env name documents the SAME value the dApp can surface if needed.
   */
  feedEnv: (chainId: number) => string
}

/**
 * The canonical pay-token set, in display order. USDC leads (the default);
 * WETH/LINK/UNI/ENS/DAI/WBTC follow. These are PUBLIC tokens/standards — their
 * symbols and names are public, not anyone's private brand.
 *
 * Decimals are the canonical mainnet values (WBTC = 8, USDC/USDT-style = 6, the
 * rest 18). They are DISPLAY metadata; the on-chain path always reads `decimals()`.
 */
export const SUPPORTED_PAY_TOKENS: readonly PayTokenMeta[] = [
  {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    // USDC reuses the EXISTING per-chain USDC vars from chains.ts — no duplicate.
    addressEnv: (chainId) => `NEXT_PUBLIC_USDC_ADDRESS_${chainId}`,
    feedEnv: (chainId) => `NEXT_PUBLIC_USDC_USD_FEED_${chainId}`,
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    addressEnv: (chainId) => `NEXT_PUBLIC_TOKEN_WETH_${chainId}`,
    feedEnv: (chainId) => `NEXT_PUBLIC_TOKEN_WETH_FEED_${chainId}`,
  },
  {
    symbol: 'LINK',
    name: 'Chainlink',
    decimals: 18,
    addressEnv: (chainId) => `NEXT_PUBLIC_TOKEN_LINK_${chainId}`,
    feedEnv: (chainId) => `NEXT_PUBLIC_TOKEN_LINK_FEED_${chainId}`,
  },
  {
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    addressEnv: (chainId) => `NEXT_PUBLIC_TOKEN_UNI_${chainId}`,
    feedEnv: (chainId) => `NEXT_PUBLIC_TOKEN_UNI_FEED_${chainId}`,
  },
  {
    symbol: 'ENS',
    name: 'Ethereum Name Service',
    decimals: 18,
    addressEnv: (chainId) => `NEXT_PUBLIC_TOKEN_ENS_${chainId}`,
    feedEnv: (chainId) => `NEXT_PUBLIC_TOKEN_ENS_FEED_${chainId}`,
  },
  {
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    addressEnv: (chainId) => `NEXT_PUBLIC_TOKEN_DAI_${chainId}`,
    feedEnv: (chainId) => `NEXT_PUBLIC_TOKEN_DAI_FEED_${chainId}`,
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    addressEnv: (chainId) => `NEXT_PUBLIC_TOKEN_WBTC_${chainId}`,
    feedEnv: (chainId) => `NEXT_PUBLIC_TOKEN_WBTC_FEED_${chainId}`,
  },
]

/** The default pay token symbol — USDC always leads (it is the booth-confirmed lead coin). */
export const DEFAULT_PAY_TOKEN: PayTokenSymbol = 'USDC'

/** Look up a token's static metadata by symbol, or `undefined` if it isn't supported. */
export function payTokenBySymbol(symbol: string): PayTokenMeta | undefined {
  return SUPPORTED_PAY_TOKENS.find((t) => t.symbol === symbol)
}

/** A token resolved against a specific chain — address present iff env-configured there. */
export interface ResolvedPayToken extends PayTokenMeta {
  /** The on-chain ERC-20 address on this chain, or `undefined` until env-configured. */
  address: Address | undefined
  /** The Chainlink <token>/USD feed address on this chain, or `undefined` if unset. */
  feed: Address | undefined
  /**
   * True only when the ADDRESS is configured on this chain — i.e. the token can be
   * selected and paid. The feed is wired into the Router at deploy, so the picker
   * keys availability off the address (the on-chain `quote()` is the real gate, and
   * a missing feed surfaces honestly there as `Access0x1__InvalidPrice`).
   */
  available: boolean
}

/**
 * Read a `NEXT_PUBLIC_*` token address/feed from env. Returns `undefined` for an
 * empty/unset var (the placeholder rows in `.env.example` are empty until booth-
 * confirmed), never a guessed value. Trims whitespace and rejects the zero address
 * (a zero address is "not configured", mirroring the deploy script's address(0) skip).
 */
function readEnvAddress(name: string): Address | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^0x0{40}$/i.test(trimmed)) return undefined
  return trimmed as Address
}

/**
 * Resolve a single token's address + feed against a chain. The address keys
 * availability; an unconfigured token is `{ available: false, address: undefined }`
 * so the picker can show it DISABLED with an honest note rather than hide it.
 *
 * @param meta    The token's static metadata.
 * @param chainId The active chain.
 */
export function resolvePayToken(meta: PayTokenMeta, chainId: number): ResolvedPayToken {
  const address = readEnvAddress(meta.addressEnv(chainId))
  const feed = readEnvAddress(meta.feedEnv(chainId))
  return { ...meta, address, feed, available: address !== undefined }
}

/**
 * Resolve the WHOLE pay-token set for a chain, in display order. USDC stays first.
 * Every token is returned (configured or not) so the picker renders the full menu
 * with unconfigured coins disabled + labelled "not available on this chain" —
 * honest, never a hidden or invented option.
 *
 * @param chainId The active chain.
 */
export function resolvePayTokens(chainId: number): ResolvedPayToken[] {
  return SUPPORTED_PAY_TOKENS.map((meta) => resolvePayToken(meta, chainId))
}

/**
 * The default selectable token for a chain. USDC when it's configured (the normal
 * case); otherwise the first configured token so the picker opens on something
 * payable. Returns `undefined` only when NO token is configured on the chain (the
 * checkout then surfaces the existing "USDC not configured" error path).
 *
 * @param chainId The active chain.
 */
export function defaultPayToken(chainId: number): ResolvedPayToken | undefined {
  const resolved = resolvePayTokens(chainId)
  const usdc = resolved.find((t) => t.symbol === DEFAULT_PAY_TOKEN && t.available)
  if (usdc) return usdc
  return resolved.find((t) => t.available)
}
