import { defineChain, type Address, type Chain } from 'viem'
import {
  baseSepolia,
  zksyncSepoliaTestnet,
  polygonAmoy,
  avalancheFuji,
  bscTestnet,
  scrollSepolia,
  lineaSepolia,
  mantleSepoliaTestnet,
  blastSepolia,
  unichainSepolia,
  // MAINNET chain definitions — AUDIT-GATED, NOT DEPLOYED (see MAINNET_CHAINS below). Importing a
  // viem chain object only carries its public id/native/explorer metadata; it makes NO claim that
  // Access0x1 is live there. No mainnet address is ever hardcoded — they resolve from env, undefined
  // until set.
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  bsc,
  scroll,
  linea,
  mantle,
  blast,
  unichain,
  zksync,
} from 'viem/chains'

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
      // `||` (not `??`): a BLANK env value (e.g. a wholesale-copied .env.example)
      // must fall back to the public default, never yield an empty RPC URL.
      http: [process.env.NEXT_PUBLIC_ARC_RPC_URL || DEFAULT_ARC_RPC_URL],
    },
  },
  testnet: true,
})

/**
 * Every chain checkout-web supports. Arc is the lead; the others are bridge
 * targets. All the testnets below settle in the canonical 6-dec bridged USDC and
 * pay gas in their OWN native token (ETH / POL / AVAX / tBNB / MNT) — so NONE of
 * them is "gas-free" the way Arc is (see {@link isGasFree}). The viem chain
 * objects carry each chain's id, native currency, public RPC and explorer; we
 * never re-literalize an id or an explorer URL we'd otherwise invent (law #4).
 *
 * The on-chain USDC + router addresses for each chain are NEVER hardcoded here —
 * they resolve from `NEXT_PUBLIC_USDC_ADDRESS_<id>` / `NEXT_PUBLIC_ROUTER_ADDRESS_<id>`
 * at the call site (see {@link getUsdcAddress} / {@link getRouterAddress}), and a
 * missing value throws rather than guessing. "USDC undefined until confirmed."
 */
export const SUPPORTED_CHAINS: readonly [Chain, ...Chain[]] = [
  arcTestnet,
  baseSepolia,
  zksyncSepoliaTestnet,
  polygonAmoy,
  avalancheFuji,
  bscTestnet,
  scrollSepolia,
  lineaSepolia,
  mantleSepoliaTestnet,
  blastSepolia,
  unichainSepolia,
]

/**
 * MAINNET chain profiles — **AUDIT-GATED, NOT DEPLOYED**.
 *
 * Every chain above has a testnet profile; this is the mainnet TWIN of each, kept SEPARATE from
 * {@link SUPPORTED_CHAINS} on purpose. Listing a chain here is config/readiness ONLY — it makes **no
 * claim** that Access0x1 is live on mainnet. This repo is testnet-only and unaudited; there is **no
 * mainnet deployment**. A mainnet target is reachable only after a third-party audit, via the
 * banner-gated `make deploy-<chain>-mainnet` flow.
 *
 * As with the testnets, NO on-chain address is hardcoded here — router/USDC addresses resolve from
 * `NEXT_PUBLIC_ROUTER_ADDRESS_<id>` / `NEXT_PUBLIC_USDC_ADDRESS_<id>` and are **undefined until set**
 * (law #4: never a guessed address). The viem objects carry only each chain's public id, native
 * currency, RPC and explorer.
 *
 * Arc MAINNET is INTENTIONALLY ABSENT: Arc is testnet-only today and its mainnet chain id is not
 * launched/known, so we never invent it here (mirrors the contract-side `ARC_MAINNET_CHAIN_ID` env).
 */
export const MAINNET_CHAINS: readonly [Chain, ...Chain[]] = [
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  bsc,
  scroll,
  linea,
  mantle,
  blast,
  unichain,
  zksync,
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
  // The additional EVM testnets all settle in the canonical 6-dec bridged USDC
  // (native gas is ETH / POL / AVAX / tBNB / MNT — NOT USDC — so none are gas-free).
  [polygonAmoy.id]: 6,
  [avalancheFuji.id]: 6,
  [bscTestnet.id]: 6,
  [scrollSepolia.id]: 6,
  [lineaSepolia.id]: 6,
  [mantleSepoliaTestnet.id]: 6,
  [blastSepolia.id]: 6,
  [unichainSepolia.id]: 6,
  // MAINNET display decimals (AUDIT-GATED, NOT DEPLOYED). Canonical Circle USDC is the 6-dec ERC-20 on
  // every one of these chains; native gas is the chain's OWN token (ETH / POL / AVAX / BNB / MNT), so
  // none is gas-free. Display-only — the money path always reads decimals() on-chain.
  [mainnet.id]: 6,
  [base.id]: 6,
  [arbitrum.id]: 6,
  [optimism.id]: 6,
  [polygon.id]: 6,
  [avalanche.id]: 6,
  [bsc.id]: 6,
  [scroll.id]: 6,
  [linea.id]: 6,
  [mantle.id]: 6,
  [blast.id]: 6,
  [unichain.id]: 6,
  [zksync.id]: 6,
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
 * MAINNET: this stays `false` for EVERY mainnet in {@link MAINNET_CHAINS}. Gas-free
 * USDC is an Arc-only property, and Arc MAINNET is not launched (no chain id, not
 * deployed), so no mainnet here is — or claims to be — gas-free.
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
 * Static per-chain env lookups for NEXT_PUBLIC_* addresses.
 *
 * Next.js inlines NEXT_PUBLIC_* env vars at BUILD TIME — but ONLY when the key
 * is a literal string at the call site. A computed key like
 * `process.env[\`NEXT_PUBLIC_ROUTER_ADDRESS_${chainId}\`]` is NOT inlined into
 * the client bundle, so the value is always undefined in the browser.
 *
 * This map lists every chain id we ship with a static literal for each key so
 * that Next's transform inlines the value correctly. The generic
 * `getRouterAddress` / `getUsdcAddress` functions below fall through to these
 * statics for the known chains and remain dynamic (server-side) for others.
 */
/**
 * The CREATE3 mirror router — the SAME deterministic address on every chain it's
 * deployed to (CREATE3 salt = deployer+label, never block.chainid). A plain literal
 * (not env), so Next inlines it into the CLIENT bundle for ALL chains — not just the
 * per-chain-env Base case below. Making the mirror the zero-config DEFAULT is the
 * whole point of CREATE3: one address everywhere. A per-chain env value still overrides.
 */
export const MIRROR_ROUTER_ADDRESS =
  '0xe92244e3368561faf21648146511DeDE3a475EB5' as Address

/**
 * Arc Testnet USDC — the chain-spec NATIVE/system USDC (`0x3600…0000`). On Arc,
 * USDC IS the gas token, so this address is a public chain fact (like the chain
 * id itself), not a per-deploy value — which is why it may live as a literal
 * (same precedent as {@link MIRROR_ROUTER_ADDRESS}). Defined HERE (the chain
 * registry) and re-exported by `arc-constants.ts` so the two can never drift;
 * `getUsdcAddress` uses it as the zero-config default for Arc, and a
 * `NEXT_PUBLIC_USDC_ADDRESS_5042002` env value still overrides it.
 */
export const ARC_TESTNET_USDC_ADDRESS =
  '0x3600000000000000000000000000000000000000' as const

/**
 * Base Sepolia USDC — Circle's CANONICAL testnet USDC (`0x036C…F7e`). Like the
 * Arc system USDC and the {@link MIRROR_ROUTER_ADDRESS}, this is a public,
 * documented chain fact rather than a per-deploy value, so it may live as a
 * literal and serve as the zero-config default for chain 84532.
 *
 * This is NOT a guessed address (doctrine #4): it was verified on-chain against
 * the live mirror router — `tokenAllowed(0x036C…F7e) == true` AND `quote()`
 * returns a real amount through the Chainlink USDC/USD feed. Base Sepolia is the
 * chain that carries the live, `active` merchant #1, so without this default the
 * hosted checkout there fails CLIENT-SIDE on a fresh clone (the computed env key
 * is never inlined into the browser) even though the on-chain path is ready.
 * A `NEXT_PUBLIC_USDC_ADDRESS_84532` env value still overrides it.
 */
export const BASE_SEPOLIA_USDC_ADDRESS =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const

/**
 * Chains where the mirror router is DEPLOYED + broadcast-verified (README
 * Deployments / MIRROR-STATUS, 2026-07). The mirror is the default router on these;
 * a chain NOT listed has no mirror, so `getRouterAddress` fails loud rather than claim
 * a router that isn't on-chain (doctrine #4: never claim an unproven address).
 */
export const MIRROR_SUPPORTED_CHAIN_IDS: readonly number[] = [
  5042002, // Arc
  84532, // Base Sepolia
  11155111, // Ethereum Sepolia
  11155420, // Optimism Sepolia
  43113, // Avalanche Fuji
  46630, // Robinhood
  421614, // Arbitrum Sepolia
  11142220, // Celo Sepolia
]

// Every documented checkout chain gets a LITERAL env key here so Next inlines
// the value into the CLIENT bundle (a computed `..._${chainId}` key never
// inlines — the browser would see undefined even with the env set). An empty
// string (e.g. a wholesale-copied .env.example) normalizes to undefined via
// `|| undefined` so the mirror/Arc defaults below still apply — a blank var can
// never shadow a working default.
const ROUTER_ADDRESS_BY_CHAIN: Readonly<Partial<Record<number, string>>> = {
  [ARC_TESTNET_ID]: process.env.NEXT_PUBLIC_ROUTER_ADDRESS_5042002 || undefined,
  [baseSepolia.id]: process.env.NEXT_PUBLIC_ROUTER_ADDRESS_84532 || undefined,
  [zksyncSepoliaTestnet.id]: process.env.NEXT_PUBLIC_ROUTER_ADDRESS_300 || undefined,
}

const USDC_ADDRESS_BY_CHAIN: Readonly<Partial<Record<number, string>>> = {
  [ARC_TESTNET_ID]: process.env.NEXT_PUBLIC_USDC_ADDRESS_5042002 || undefined,
  [baseSepolia.id]: process.env.NEXT_PUBLIC_USDC_ADDRESS_84532 || undefined,
  [zksyncSepoliaTestnet.id]: process.env.NEXT_PUBLIC_USDC_ADDRESS_300 || undefined,
}

/**
 * Resolve the Access0x1Router address for a chain from
 * `NEXT_PUBLIC_ROUTER_ADDRESS_<chainId>`. Throws (never returns undefined) so a
 * missing config surfaces loudly instead of producing a silent wrong call.
 * Doctrine guardrail #5: no address from memory.
 *
 * NOTE: for client-bundle chains (e.g. Base Sepolia 84532) we read from
 * {@link ROUTER_ADDRESS_BY_CHAIN} which uses literal env keys that Next inlines.
 * The computed `process.env[\`..._${chainId}\`]` form is server-side only.
 */
export function getRouterAddress(chainId: number): Address {
  const addr =
    // 1) explicit per-chain env override (literal key → inlined client-side)
    ROUTER_ADDRESS_BY_CHAIN[chainId] ??
    // 2) server-side per-chain env (computed key, not inlined into the browser);
    //    `|| undefined` so a blank var never shadows the mirror default below
    (typeof window === 'undefined'
      ? (process.env[`NEXT_PUBLIC_ROUTER_ADDRESS_${chainId}`] || undefined)
      : undefined) ??
    // 3) the CREATE3 mirror as the zero-config DEFAULT on every mirrored chain —
    //    same address everywhere, inlined client-side. This is why an integrator
    //    needs no per-chain router env: "make everything mirrored by default."
    (MIRROR_SUPPORTED_CHAIN_IDS.includes(chainId) ? MIRROR_ROUTER_ADDRESS : undefined)
  // A non-mirrored, unconfigured chain still fails loud — never a silent wrong call.
  if (!addr) throw new Error(`No router address configured for chain ${chainId}`)
  return addr as Address
}

/**
 * Resolve the allowlisted USDC address for a chain from
 * `NEXT_PUBLIC_USDC_ADDRESS_<chainId>`. Throws on a missing config.
 *
 * See {@link getRouterAddress} for the static-vs-computed env key rationale.
 */
export function getUsdcAddress(chainId: number): Address {
  const addr =
    USDC_ADDRESS_BY_CHAIN[chainId] ??
    (typeof window === 'undefined'
      ? (process.env[`NEXT_PUBLIC_USDC_ADDRESS_${chainId}`] || undefined)
      : undefined) ??
    // Zero-config default for the LEAD chain: Arc's USDC is the chain-spec
    // native/system token (see {@link ARC_TESTNET_USDC_ADDRESS}) — a public
    // chain fact, not a guessed deploy address. Same doctrine carve-out as the
    // CREATE3 mirror default in getRouterAddress; env above still overrides.
    // Without this, the default-chain checkout quote fails CLIENT-SIDE on a
    // fresh clone (the computed env key is never inlined into the browser).
    (chainId === ARC_TESTNET_ID ? ARC_TESTNET_USDC_ADDRESS : undefined) ??
    // Zero-config default for Base Sepolia — Circle's canonical testnet USDC
    // (see {@link BASE_SEPOLIA_USDC_ADDRESS}), verified allowlisted + quotable on
    // the live mirror router. This is the chain with the live `active` merchant
    // #1, so this default is what makes an out-of-the-box hosted checkout settle
    // there with no env; same public-fact carve-out as Arc, env above overrides.
    (chainId === baseSepolia.id ? BASE_SEPOLIA_USDC_ADDRESS : undefined)
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
 *
 * For the additional EVM testnets we read each explorer URL straight off its viem
 * chain object (`blockExplorers.default.url`) rather than re-literalizing a string
 * here — so the link can never drift from the canonical viem definition, and an
 * explorer-less chain simply never appears in this map (its hash renders as text).
 */
const EXPLORER_BASE_URLS: Readonly<Record<number, string>> = {
  [baseSepolia.id]: 'https://sepolia.basescan.org',
  [zksyncSepoliaTestnet.id]: 'https://sepolia.explorer.zksync.io',
  [polygonAmoy.id]: polygonAmoy.blockExplorers.default.url,
  [avalancheFuji.id]: avalancheFuji.blockExplorers.default.url,
  [bscTestnet.id]: bscTestnet.blockExplorers.default.url,
  [scrollSepolia.id]: scrollSepolia.blockExplorers.default.url,
  [lineaSepolia.id]: lineaSepolia.blockExplorers.default.url,
  [mantleSepoliaTestnet.id]: mantleSepoliaTestnet.blockExplorers.default.url.replace(/\/$/, ''),
  [blastSepolia.id]: blastSepolia.blockExplorers.default.url,
  [unichainSepolia.id]: unichainSepolia.blockExplorers.default.url,
  // MAINNET explorers (AUDIT-GATED, NOT DEPLOYED) — read straight off each viem chain object so the
  // link can never drift from the canonical definition. Present here only so a (future, post-audit)
  // mainnet tx hash renders as a real link rather than plain text; this maps NO Access0x1 deployment.
  [mainnet.id]: mainnet.blockExplorers.default.url.replace(/\/$/, ''),
  [base.id]: base.blockExplorers.default.url.replace(/\/$/, ''),
  [arbitrum.id]: arbitrum.blockExplorers.default.url.replace(/\/$/, ''),
  [optimism.id]: optimism.blockExplorers.default.url.replace(/\/$/, ''),
  [polygon.id]: polygon.blockExplorers.default.url.replace(/\/$/, ''),
  [avalanche.id]: avalanche.blockExplorers.default.url.replace(/\/$/, ''),
  [bsc.id]: bsc.blockExplorers.default.url.replace(/\/$/, ''),
  [scroll.id]: scroll.blockExplorers.default.url.replace(/\/$/, ''),
  [linea.id]: linea.blockExplorers.default.url.replace(/\/$/, ''),
  [mantle.id]: mantle.blockExplorers.default.url.replace(/\/$/, ''),
  [blast.id]: blast.blockExplorers.default.url.replace(/\/$/, ''),
  [unichain.id]: unichain.blockExplorers.default.url.replace(/\/$/, ''),
  [zksync.id]: zksync.blockExplorers.default.url.replace(/\/$/, ''),
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
