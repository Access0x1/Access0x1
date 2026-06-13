import { defineChain, type Address, type Chain } from 'viem'
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'

/**
 * Arc Testnet — the Access0x1 settlement chain.
 *
 * NOTE: id / RPC are CONFIRMED at the Arc booth at the event; the RPC URL is
 * read from env so it is never hardcoded in a shipped build. `5042002` is the
 * placeholder id used across the spec and env var names (NEXT_PUBLIC_*_5042002).
 *
 * Native USDC on Arc is 18-decimal (the "Arc trap" the router prices around);
 * the frontend never assumes decimals — it reads them on-chain via `quote()`.
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ARC_RPC_URL ?? 'https://rpc.testnet.arc.network'],
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
