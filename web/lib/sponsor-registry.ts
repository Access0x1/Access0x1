import type { Abi, Address, Hash, PublicClient, WalletClient } from 'viem'
import { zeroAddress } from 'viem'
import { baseSepolia, zksyncSepoliaTestnet } from 'viem/chains'
import { ARC_TESTNET_ID } from './chains'

/**
 * Access0x1SponsorRegistry — the on-chain record of WHO sponsors a merchant's
 * gas (record-only v1).
 *
 * ABI is FROZEN against `src/Access0x1SponsorRegistry.sol` (branch
 * `feat/sponsor-registry`). Two-step consent, mirrored exactly:
 *   - ANY wallet may `offerSponsorship(merchantId)` — inert until accepted.
 *   - Only the merchant seat's LIVE owner may `acceptSponsor(merchantId)`;
 *     acceptance sets `sponsorOf(merchantId)`, THE record (CONNECTED iff
 *     non-zero).
 *   - Either the owner or the recorded/pending sponsor may
 *     `clearSponsor(merchantId)`.
 *   - `pendingSponsorOf(merchantId)` = an offer awaiting acceptance.
 *
 * RECORD-ONLY v1: this registry gates NO money path — gasless settlement stays
 * any-relayer. The UI treats it as a status surface, never a payment gate.
 */
export const SPONSOR_REGISTRY_ABI = [
  // --- reads ---
  {
    type: 'function',
    name: 'sponsorOf',
    stateMutability: 'view',
    inputs: [{ name: 'merchantId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'pendingSponsorOf',
    stateMutability: 'view',
    inputs: [{ name: 'merchantId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  // --- writes ---
  {
    type: 'function',
    name: 'offerSponsorship',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'merchantId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'acceptSponsor',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'merchantId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'clearSponsor',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'merchantId', type: 'uint256' }],
    outputs: [],
  },
  // --- events ---
  {
    type: 'event',
    name: 'SponsorshipOffered',
    inputs: [
      { name: 'merchantId', type: 'uint256', indexed: true },
      { name: 'sponsor', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'SponsorAccepted',
    inputs: [
      { name: 'merchantId', type: 'uint256', indexed: true },
      { name: 'sponsor', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'SponsorCleared',
    inputs: [
      { name: 'merchantId', type: 'uint256', indexed: true },
      { name: 'sponsor', type: 'address', indexed: true },
      { name: 'byMerchant', type: 'bool', indexed: false },
    ],
  },
] as const satisfies Abi

/**
 * The CREATE3 mirror SponsorRegistry proxy — the SAME deterministic lattice
 * address on every chain ONCE DEPLOYED. Same class of public fact as
 * {@link import('./chains').MIRROR_ROUTER_ADDRESS} (CREATE3 salt =
 * deployer+label, never block.chainid), so it may live as a literal — BUT it is
 * **COMPUTED, NOT YET DEPLOYED**: as of 2026-07 the registry is on-chain
 * NOWHERE. The UI must therefore never assume code lives here —
 * {@link readSponsorState} `getCode`-gates every read and renders the honest
 * "not on this chain yet" state until the module actually lands.
 */
export const MIRROR_SPONSOR_REGISTRY_ADDRESS =
  '0x9dc48b96b9Fc737d4CDf0dcC7B56164e6464B736' as Address

// Literal env keys for the client-bundle chains, mirroring the
// ROUTER_ADDRESS_BY_CHAIN pattern in chains.ts: Next.js only inlines
// NEXT_PUBLIC_* vars whose key is a LITERAL at the call site — a computed
// `..._${chainId}` key is never inlined into the browser. `|| undefined` so a
// blank var (wholesale-copied .env.example) can never shadow the mirror default.
const SPONSOR_REGISTRY_ADDRESS_BY_CHAIN: Readonly<Partial<Record<number, string>>> = {
  [ARC_TESTNET_ID]: process.env.NEXT_PUBLIC_SPONSOR_REGISTRY_ADDRESS_5042002 || undefined,
  [baseSepolia.id]: process.env.NEXT_PUBLIC_SPONSOR_REGISTRY_ADDRESS_84532 || undefined,
  [zksyncSepoliaTestnet.id]: process.env.NEXT_PUBLIC_SPONSOR_REGISTRY_ADDRESS_300 || undefined,
}

/**
 * Resolve the SponsorRegistry address for a chain:
 *   1. `NEXT_PUBLIC_SPONSOR_REGISTRY_ADDRESS_<chainId>` env override (literal
 *      key → inlined client-side; computed key server-side only), then
 *   2. the CREATE3 mirror proxy as the zero-config default on EVERY chain.
 *
 * Unlike `getRouterAddress` this never throws: the mirror address is the same
 * lattice fact everywhere, and honesty is enforced ON-CHAIN instead —
 * {@link readSponsorState} checks `getCode` first, so a chain where the
 * registry hasn't landed resolves to the truthful `{ deployed: false }` state
 * rather than a guessed-live address.
 */
export function getSponsorRegistryAddress(chainId: number): Address {
  const addr =
    SPONSOR_REGISTRY_ADDRESS_BY_CHAIN[chainId] ??
    (typeof window === 'undefined'
      ? process.env[`NEXT_PUBLIC_SPONSOR_REGISTRY_ADDRESS_${chainId}`] || undefined
      : undefined) ??
    MIRROR_SPONSOR_REGISTRY_ADDRESS
  return addr as Address
}

/**
 * What the dashboard knows about a merchant's gas sponsorship on ONE chain.
 *
 * `deployed` is a tri-state, each with a distinct honest render:
 *   - `false` — no code at the registry address: the registry is NOT on this
 *     chain yet (the truthful state everywhere until the module lands).
 *   - `true`  — the registry is live here; `sponsor`/`pending` are the record.
 *   - `null`  — UNKNOWN: the chain couldn't be reached (RPC error). Never
 *     conflated with "not deployed" — the caller keeps its last good state.
 */
export interface SponsorState {
  deployed: boolean | null
  /** The ACCEPTED sponsor (`sponsorOf`), or null when zero — CONNECTED iff set. */
  sponsor: Address | null
  /** An offer awaiting the owner's acceptance (`pendingSponsorOf`), or null. */
  pending: Address | null
}

/** Map the contract's zero-address sentinel to null. */
function nonZeroOrNull(addr: Address): Address | null {
  return addr.toLowerCase() === zeroAddress ? null : addr
}

/**
 * Read a merchant's sponsor state, FAIL-SOFT — this never throws to the UI.
 *
 *   1. `getCode` first: no code at the address ⇒ `{ deployed: false }` — the
 *      honest "registry not on this chain yet" state (the mirror proxy address
 *      is computed but deployed nowhere yet).
 *   2. Code present ⇒ read `sponsorOf` + `pendingSponsorOf`; zero ⇒ null.
 *   3. ANY RPC error (getCode or the reads) ⇒ the DISTINCT unknown state
 *      `{ deployed: null }` so a transient network blip is never rendered as
 *      "not deployed" or as a fake empty record.
 */
export async function readSponsorState(
  publicClient: PublicClient,
  chainId: number,
  merchantId: bigint,
): Promise<SponsorState> {
  const address = getSponsorRegistryAddress(chainId)

  let code: string | undefined
  try {
    code = await publicClient.getCode({ address })
  } catch {
    return { deployed: null, sponsor: null, pending: null }
  }
  if (!code || code === '0x') {
    return { deployed: false, sponsor: null, pending: null }
  }

  try {
    const [sponsor, pending] = await Promise.all([
      publicClient.readContract({
        address,
        abi: SPONSOR_REGISTRY_ABI,
        functionName: 'sponsorOf',
        args: [merchantId],
      }),
      publicClient.readContract({
        address,
        abi: SPONSOR_REGISTRY_ABI,
        functionName: 'pendingSponsorOf',
        args: [merchantId],
      }),
    ])
    return {
      deployed: true,
      sponsor: nonZeroOrNull(sponsor),
      pending: nonZeroOrNull(pending),
    }
  } catch {
    // Code exists but the reads failed (RPC blip / revert) — unknown, not a
    // fabricated empty record.
    return { deployed: null, sponsor: null, pending: null }
  }
}

/** The three registry writes the panel can submit. */
export type SponsorRegistryWrite = 'offerSponsorship' | 'acceptSponsor' | 'clearSponsor'

/**
 * Submit one SponsorRegistry write and wait for its receipt. Callers pin the
 * wallet to `chainId` FIRST (`ensureChain`) — this helper only resolves the
 * per-chain address and submits, mirroring the `contracts.ts` write idiom.
 * Zero custody: every function here writes a consent record; no funds move.
 */
export async function writeSponsorRegistry(
  walletClient: WalletClient,
  publicClient: PublicClient,
  chainId: number,
  merchantId: bigint,
  functionName: SponsorRegistryWrite,
): Promise<{ txHash: Hash }> {
  const account = walletClient.account
  if (!account) throw new Error('Wallet has no account connected')

  const txHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: getSponsorRegistryAddress(chainId),
    abi: SPONSOR_REGISTRY_ABI,
    functionName,
    args: [merchantId],
  })
  await publicClient.waitForTransactionReceipt({ hash: txHash })
  return { txHash }
}
