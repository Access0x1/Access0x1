/**
 * public-status.ts — the REVIEWED, CHAIN-VERIFIED public deployment-state model.
 *
 * WHY THIS FILE EXISTS. `lib/deployments.ts` is generated from the committed `broadcast/`
 * records, so it is a faithful account of what a deploy script RECORDED — which is not the
 * same as what is live. The two diverge in both directions, and the public count has to come
 * from chain state, not from either assumption:
 *
 *   - It can UNDER-count. The mirror router is live and functional on 0G Galileo (16602),
 *     but no committed broadcast record lists it there at the mirror address, so a
 *     manifest-derived count silently omits it. This is exactly why the landing page
 *     rendered "9 testnets" when ten chains actually answer.
 *   - It can OVER-count. The manifest also carries the two pre-mirror chains (Hoodi 560048,
 *     Tempo 42431), which do NOT have the mirror router — verified absent on-chain.
 *
 * VERIFICATION METHOD (do not weaken this). A chain earns a place in
 * {@link CONFIRMED_MIRROR_CHAIN_IDS} only by answering on its own RPC: `eth_chainId` must
 * match the expected id (so the endpoint is really that chain), `eth_getCode` at
 * {@link MIRROR_ROUTER} must be non-empty, and `owner()` must return the deployer. A
 * manifest entry is NOT evidence, and neither is a doc.
 *
 * LAST VERIFIED 2026-07-30 against live RPCs: all ten chains below returned the expected
 * chain id, non-empty code at the mirror address (a byte-identical ERC-1967 minimal proxy),
 * and the same owner. Controls run the same day: a bogus address returned empty code on the
 * same endpoints, and Hoodi + Tempo returned empty code at the mirror address.
 *
 * CHANGING THIS FILE IS AN OWNER DECISION — adding an id makes a new public claim.
 *
 * @see components/marketing/ProofBand.tsx — the only public consumer today.
 */

/** The address every mirrored chain shares (CREATE3, so it is identical everywhere). */
export const MIRROR_ROUTER = '0xe92244e3368561faf21648146511DeDE3a475EB5' as const

/**
 * How a chain relates to the PUBLIC deployment story.
 *
 * - `confirmed-mirror` — mirror router verified live on-chain. **Only this may be counted.**
 * - `pre-mirror` — an earlier per-chain deploy; the mirror is verified ABSENT here.
 * - `local` — a development chain (Anvil); never public.
 * - `unverified` — not yet checked against chain state. Treated as NOT public.
 */
export type ChainStatus = 'confirmed-mirror' | 'pre-mirror' | 'local' | 'unverified'

/**
 * The ten chain-verified mirror testnets — the single source of the public count.
 *
 * NOTE ON 0G (16602): live on-chain, but absent from the committed broadcast records at the
 * mirror address, so it cannot be derived from `lib/deployments.ts`. That gap is the whole
 * reason the count lives here. If `make sync` ever picks it up, this list stays authoritative.
 */
export const CONFIRMED_MIRROR_CHAIN_IDS: ReadonlyArray<number> = [
  5042002, // Arc Testnet
  84532, // Base Sepolia
  11155111, // Ethereum Sepolia
  11155420, // OP Sepolia
  421614, // Arbitrum Sepolia
  43113, // Avalanche Fuji
  11142220, // Celo Sepolia
  46630, // Robinhood Chain Testnet
  300, // ZKsync Sepolia — EraVM build path differs; the router still answers
  16602, // 0G Galileo — live on-chain, NOT in broadcast/ (see note above)
] as const

/** Explicit non-public classifications, so an unlisted chain is never silently counted. */
const NON_PUBLIC_STATUS: ReadonlyMap<number, ChainStatus> = new Map([
  [560048, 'pre-mirror'], // Hoodi — mirror verified ABSENT 2026-07-30
  [42431, 'pre-mirror'], // Tempo (Moderato) — mirror verified ABSENT 2026-07-30
  [31337, 'local'], // Anvil
])

/** Classify a chain id. Anything not explicitly listed is `unverified`, never public. */
export function chainStatus(chainId: number): ChainStatus {
  if (CONFIRMED_MIRROR_CHAIN_IDS.includes(chainId)) return 'confirmed-mirror'
  return NON_PUBLIC_STATUS.get(chainId) ?? 'unverified'
}

/** True only for chains that may appear in a public deployment claim. */
export function isPubliclyClaimable(chainId: number): boolean {
  return chainStatus(chainId) === 'confirmed-mirror'
}

/** The public mirror count. Derived from the verified list, never from manifest length. */
export const CONFIRMED_MIRROR_COUNT: number = CONFIRMED_MIRROR_CHAIN_IDS.length

/**
 * How many of the mirrored routers are source-verified on their block explorer. Lower than
 * the deploy count by design — verification is per-explorer and some testnets have no
 * verifying explorer. Kept beside the count so copy can never imply all ten are verified.
 */
export const SOURCE_VERIFIED_COUNT = 7 as const
