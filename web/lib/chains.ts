import { defineChain, type Address, type Chain } from 'viem'
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'

/**
 * Arc Testnet EVM chain id. `5042002` is the id used across the spec and the
 * `NEXT_PUBLIC_*` env-var names (confirmed at the Arc/Circle booth).
 *
 * This module is the SINGLE source of truth for Arc chain metadata in the web
 * app — `embedConfig.ts` and `arc-constants.ts` import {@link ARC_TESTNET_ID}
 * and {@link DEFAULT_ARC_RPC_URL} from here instead of re-literalizing them, so
 * the Arc RPC string and chain id can never drift across files.
 */
export const ARC_TESTNET_ID = 5042002

/**
 * The default (public, no-key) Arc Testnet JSON-RPC endpoint. Lives in exactly
 * ONE place; every other registry imports it. A deployed build overrides it via
 * `NEXT_PUBLIC_ARC_RPC_URL` (the URL is never assumed at a call site).
 *
 * confirm at booth
 */
export const DEFAULT_ARC_RPC_URL = 'https://rpc.testnet.arc.network'

/**
 * Arc Testnet — the Access0x1 settlement chain.
 *
 * NOTE: id / RPC are CONFIRMED at the Arc booth at the event; the RPC URL is
 * read from env so it is never hardcoded in a shipped build, falling back to
 * {@link DEFAULT_ARC_RPC_URL}.
 *
 * Native USDC on Arc is 18-decimal (the "Arc trap" the router prices around);
 * the frontend never assumes decimals — it reads them on-chain via `quote()`.
 */
export const arcTestnet = defineChain({
  id: ARC_TESTNET_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ARC_RPC_URL ?? DEFAULT_ARC_RPC_URL],
    },
  },
  testnet: true,
})

/** Every chain checkout-web supports. Arc is the lead; the others are bridge targets. */
export const SUPPORTED_CHAINS: readonly [Chain, ...Chain[]] = [
  arcTestnet,
  baseSepolia,
  zksyncSepoliaTestnet,
]

/**
 * Per-chain USDC decimals — the SINGLE source of truth the UI uses to FORMAT a
 * token amount for display. The on-chain money path never reads this (the
 * router/`quote()` reads `decimals()` in-tx); this table exists ONLY so the
 * frontend renders the right number of fraction digits.
 *
 * THE ARC TRAP (the bug this fixes): Arc's native USDC is the gas token and is
 * 18-decimal, while bridged USDC on Base Sepolia and ZKsync Sepolia is the
 * canonical 6-decimal ERC-20. Hardcoding `6` everywhere divides an 18-dec Arc
 * amount by 10^6 — a 10^12 display error on the LEAD chain. We resolve decimals
 * PER CHAIN here, defaulting to each chain's `nativeCurrency.decimals` where the
 * pay-in token IS the native token (Arc), and to 6 for the bridged-USDC chains.
 *
 * Honesty: these are the decimals of the USDC each chain settles in. A chain not
 * listed falls back to {@link DEFAULT_TOKEN_DECIMALS} (6, the ERC-20 norm) rather
 * than throwing — a wrong-but-safe display beats a crash, and an unsupported
 * chain never reaches a real money path (those go through `getChain`).
 */
const USDC_DECIMALS_BY_CHAIN: Readonly<Record<number, number>> = {
  // Arc native USDC IS the gas token and is 18-dec (the "Arc trap").
  [ARC_TESTNET_ID]: arcTestnet.nativeCurrency.decimals,
  // Bridged USDC on the L2 testnets is the canonical 6-dec ERC-20.
  [baseSepolia.id]: 6,
  [zksyncSepoliaTestnet.id]: 6,
}

/** Fallback display decimals for an unknown chain — the ERC-20 USDC norm. */
export const DEFAULT_TOKEN_DECIMALS = 6

/**
 * Resolve the USDC display decimals for a chain. Used by the checkout card and
 * the receipts dashboard to format the quoted/settled token amount — NOT by the
 * money path (the contract reads decimals on-chain). Falls back to
 * {@link DEFAULT_TOKEN_DECIMALS} for an unconfigured chain rather than throwing,
 * so a display never crashes a checkout (the gate sits off the money path).
 *
 * @param chainId The chain whose USDC decimals to resolve.
 * @returns The token's display decimals (18 on Arc, 6 on the bridged-USDC L2s).
 */
export function tokenDecimalsFor(chainId: number): number {
  return USDC_DECIMALS_BY_CHAIN[chainId] ?? DEFAULT_TOKEN_DECIMALS
}

/**
 * Is USDC the NATIVE gas token on this chain? True ONLY for Arc Testnet, where
 * native USDC pays gas — so a payment there is genuinely "gas-free" in the sense
 * that the buyer needs no separate gas asset. On Base Sepolia / ZKsync Sepolia
 * the native gas token is ETH, NOT USDC, so a USDC payment there still needs ETH
 * for gas — it is NOT gas-free.
 *
 * TRUTH-IN-COPY (law #4): any "gas-free" / "no separate gas" UI copy MUST gate on
 * this — we never claim gas-free on a chain where it isn't true.
 *
 * @param chainId The chain to check.
 * @returns true only for Arc Testnet (5042002).
 */
export function isGasFree(chainId: number): boolean {
  return chainId === ARC_TESTNET_ID
}

/** Default chain id the app connects to (from env, falling back to Arc Testnet). */
export function getDefaultChainId(): number {
  const raw = process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID
  return raw ? Number(raw) : arcTestnet.id
}

/** Look up a supported chain object by id, or throw a clear error. */
export function getChain(chainId: number): Chain {
  const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId)
  if (!chain) throw new Error(`Unsupported chain id ${chainId}`)
  return chain
}

/**
 * Resolve the Access0x1Router address for a chain from
 * `NEXT_PUBLIC_ROUTER_ADDRESS_<chainId>`. Throws (never returns undefined) so a
 * missing config surfaces loudly instead of producing a silent wrong call.
 * Doctrine guardrail #5: no address from memory.
 */
export function getRouterAddress(chainId: number): Address {
  const addr = process.env[`NEXT_PUBLIC_ROUTER_ADDRESS_${chainId}`]
  if (!addr) throw new Error(`No router address configured for chain ${chainId}`)
  return addr as Address
}

/**
 * Resolve the allowlisted USDC address for a chain from
 * `NEXT_PUBLIC_USDC_ADDRESS_<chainId>`. Throws on a missing config.
 */
export function getUsdcAddress(chainId: number): Address {
  const addr = process.env[`NEXT_PUBLIC_USDC_ADDRESS_${chainId}`]
  if (!addr) throw new Error(`No USDC address configured for chain ${chainId}`)
  return addr as Address
}

/** Resolve a per-chain RPC URL from env (used by server-side public clients). */
export function getRpcUrl(chainId: number): string {
  const chain = getChain(chainId)
  return chain.rpcUrls.default.http[0]
}

/**
 * Per-chain block-explorer BASE url (no trailing slash). The SINGLE source of
 * truth for where a tx hash links. Only real, verifiable testnet explorers go
 * here (law #4 — truth in copy):
 *   - Base Sepolia (84532): https://sepolia.basescan.org (matches viem's def)
 *   - ZKsync Sepolia (300): https://sepolia.explorer.zksync.io (matches viem's def)
 *
 * Arc Testnet is INTENTIONALLY ABSENT: its explorer is not booth-confirmed, so
 * we leave it undefined and render the hash as plain text rather than invent a
 * link — mirroring the "confirm at booth" doctrine for the Arc RPC above.
 */
const EXPLORER_BASE_URLS: Readonly<Record<number, string>> = {
  [baseSepolia.id]: 'https://sepolia.basescan.org',
  [zksyncSepoliaTestnet.id]: 'https://sepolia.explorer.zksync.io',
}

/**
 * Build the block-explorer URL for a transaction hash on a given chain, or
 * `undefined` when no verifiable explorer is known for that chain (e.g. Arc).
 * Callers MUST render the hash as plain text when this returns undefined —
 * never an invented or broken link.
 */
export function explorerTxUrl(chainId: number, hash: string): string | undefined {
  const base = EXPLORER_BASE_URLS[chainId]
  if (!base) return undefined
  return `${base}/tx/${hash}`
}
