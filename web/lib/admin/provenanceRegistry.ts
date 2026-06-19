/**
 * The OWNER-ADMIN helper surface for the Access0x1ProvenanceRegistry.
 *
 * This module backs the wallet-connected `/admin` page: the owner runs every
 * owner-gated, on-chain step (deploy the registry, claim the NFTeria repo, anchor
 * a release) as a button they sign in their OWN browser wallet — NO keystore, NO
 * server, NO private key ever in the app. All it does here is:
 *   - derive NFTeria's `repoId` from the EXACT same documented string NFTeria's
 *     `lib/provenance.ts` hashes (so a claim made here matches what NFTeria reads),
 *   - validate the human inputs (cid, bytes32 merkleRoot) before they hit a tx,
 *   - wrap viem's `deployContract` / `writeContract` for the three actions, and
 *   - turn a thrown viem error into a clean, human revert reason.
 *
 * TESTNET ONLY. The admin page is gated to the testnet chains in
 * {@link ADMIN_TESTNET_CHAINS}; a mainnet chain id never reaches a write here.
 *
 * Pure of secrets, no React — the viem clients are passed IN (the page builds
 * them from the connected Dynamic wallet), so the pure helpers below are unit-
 * testable with no network.
 */
import {
  createPublicClient,
  http,
  keccak256,
  toBytes,
  defineChain,
  type Abi,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { baseSepolia, optimismSepolia, arbitrumSepolia } from 'viem/chains'
import {
  PROVENANCE_REGISTRY_ABI,
  PROVENANCE_REGISTRY_BYTECODE,
} from '@/lib/artifacts/Access0x1ProvenanceRegistry'

// ── NFTeria repo identity (MUST match NFTeria's lib/provenance.ts) ────────────
//
// NFTeria keys its on-chain claim by `keccak256(toBytes(NFTERIA_REPO_STRING))`.
// We re-derive the SAME id from the SAME string here so a claim the owner makes
// from this admin page is the exact bytes32 NFTeria's /provenance page reads
// back. The string is duplicated verbatim (the two apps are separate bundles, so
// it can't be imported); a test asserts the derivation is stable.

/**
 * The canonical, host-qualified repo string NFTeria's on-chain provenance is
 * keyed by — byte-for-byte identical to `NFTERIA_REPO_STRING` in
 * `fleet/apps/nfteria/lib/provenance.ts`. Changing it changes the on-chain
 * identity, so it is a single, deliberate source of truth.
 */
export const NFTERIA_REPO_STRING = 'github.com/doble196/fleet#apps/nfteria' as const

/**
 * Derive NFTeria's `repoId` — `keccak256(toBytes(NFTERIA_REPO_STRING))` — the
 * bytes32 the registry stores the claim + anchors under. Derived (never a
 * hard-coded literal) so it is provably the hash of the documented string and
 * can never silently drift from what NFTeria reads.
 */
export function deriveNfteriaRepoId(): Hex {
  return keccak256(toBytes(NFTERIA_REPO_STRING))
}

/** NFTeria's repoId, derived once at module load (convenience constant). */
export const NFTERIA_REPO_ID: Hex = deriveNfteriaRepoId()

// ── The testnet chain allowlist (TESTNET ONLY) ───────────────────────────────
//
// The admin page may only deploy/write on these four testnets. Arc is defined
// inline here (it is not a viem-built chain); the other three come straight from
// viem so their id / native / explorer can never drift from the canonical defs.
// This table is self-contained (not lib/chains' SUPPORTED_CHAINS) because the
// admin tool targets OP + Arb Sepolia too, which the checkout app does not list.

/** The Arc Testnet chain id — `5042002` (verified at the Arc/Circle booth). */
export const ARC_TESTNET_ID = 5042002

/** The default public Arc Testnet JSON-RPC endpoint (overridable via env). */
const DEFAULT_ARC_RPC_URL = 'https://rpc.testnet.arc.network'

/**
 * Arc Testnet — the lead settlement chain. Native USDC is the 18-decimal gas
 * token. RPC reads from `NEXT_PUBLIC_ARC_RPC_URL` so a deployed build never
 * hardcodes it. Its explorer is `https://testnet.arcscan.app` (booth-confirmed).
 */
export const arcTestnet: Chain = defineChain({
  id: ARC_TESTNET_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_ARC_RPC_URL ?? DEFAULT_ARC_RPC_URL] },
  },
  blockExplorers: {
    default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
})

/** A testnet the admin page may operate on (chain + a short display label). */
export interface AdminChain {
  /** The viem chain object (id, native currency, RPC, explorer). */
  chain: Chain
  /** A short human label for the chain picker. */
  label: string
}

/**
 * The TESTNET-ONLY chains the admin page exposes: Arc, Base Sepolia, Optimism
 * Sepolia, Arbitrum Sepolia. Every entry is a testnet (asserted by the
 * {@link isAdminTestnetChain} gate); no mainnet id ever appears here.
 */
export const ADMIN_TESTNET_CHAINS: readonly AdminChain[] = [
  { chain: arcTestnet, label: 'Arc Testnet' },
  { chain: baseSepolia, label: 'Base Sepolia' },
  { chain: optimismSepolia, label: 'Optimism Sepolia' },
  { chain: arbitrumSepolia, label: 'Arbitrum Sepolia' },
]

/** The set of chain ids the admin page permits, for an O(1) testnet gate. */
const ADMIN_CHAIN_IDS: ReadonlySet<number> = new Set(
  ADMIN_TESTNET_CHAINS.map((c) => c.chain.id),
)

/** True only for one of the four allowlisted TESTNET chains — the mainnet gate. */
export function isAdminTestnetChain(chainId: number | undefined | null): boolean {
  return chainId != null && ADMIN_CHAIN_IDS.has(chainId)
}

/** Resolve an admin chain entry by id, or null when it is not an allowed testnet. */
export function getAdminChain(chainId: number): AdminChain | null {
  return ADMIN_TESTNET_CHAINS.find((c) => c.chain.id === chainId) ?? null
}

/**
 * A read-only viem `PublicClient` for an allowed testnet chain, used to wait for
 * receipts. Throws when the chain is not an allowlisted testnet — a mainnet id
 * can never produce a client here.
 */
export function getAdminPublicClient(chainId: number): PublicClient {
  const entry = getAdminChain(chainId)
  if (!entry) throw new Error(`Chain ${chainId} is not an allowed testnet`)
  return createPublicClient({
    chain: entry.chain,
    transport: http(entry.chain.rpcUrls.default.http[0]),
  }) as PublicClient
}

// ── Explorer link helpers (real explorers only; null = no link) ──────────────

/**
 * The block-explorer URL for a tx hash on an admin chain, or null when the chain
 * has no known explorer. Callers render the hash as plain text on null — never
 * an invented or broken link.
 */
export function adminTxUrl(chainId: number, hash: string): string | null {
  const base = getAdminChain(chainId)?.chain.blockExplorers?.default?.url
  if (!base) return null
  return `${base.replace(/\/+$/, '')}/tx/${hash}`
}

/** The block-explorer URL for a contract address on an admin chain, or null. */
export function adminAddressUrl(chainId: number, address: string): string | null {
  const base = getAdminChain(chainId)?.chain.blockExplorers?.default?.url
  if (!base) return null
  return `${base.replace(/\/+$/, '')}/address/${address}`
}

// ── Input validation (pure) ──────────────────────────────────────────────────

/** A bytes32 hex value: `0x` followed by exactly 64 hex chars. */
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/

/** True when `value` is a well-formed bytes32 hex string (e.g. a merkle root). */
export function isBytes32(value: string): value is Hex {
  return BYTES32_RE.test(value.trim())
}

/** True when `value` is a non-empty content id (any non-blank string). */
export function isNonEmptyCid(value: string): boolean {
  return value.trim().length > 0
}

/** The shape the anchor-release form validates into (or an error message). */
export interface AnchorInput {
  cid: string
  tag: string
  merkleRoot: Hex
}

/**
 * Validate the anchor-release form fields. Returns the cleaned input on success,
 * or a human error string naming the FIRST problem (cid empty, or merkleRoot not
 * a 0x+64hex value). The tag is optional and passed through trimmed.
 */
export function validateAnchorInput(
  cid: string,
  tag: string,
  merkleRoot: string,
): { ok: true; value: AnchorInput } | { ok: false; error: string } {
  if (!isNonEmptyCid(cid)) {
    return { ok: false, error: 'Enter a content id (CID) — it cannot be empty.' }
  }
  if (!isBytes32(merkleRoot)) {
    return {
      ok: false,
      error: 'Merkle root must be a bytes32 value: 0x followed by exactly 64 hex characters.',
    }
  }
  return {
    ok: true,
    value: { cid: cid.trim(), tag: tag.trim(), merkleRoot: merkleRoot.trim() as Hex },
  }
}

// ── Revert humanization (pure) ───────────────────────────────────────────────

/**
 * The registry's custom-error names mapped to a clean, owner-facing reason. Kept
 * in sync with `Access0x1ProvenanceRegistry`'s custom errors (the vendored abi).
 */
const KNOWN_REVERTS: Readonly<Record<string, string>> = {
  Access0x1ProvenanceRegistry__RepoAlreadyClaimed:
    'This repo is already claimed — nothing to do (claim is first-come, first-served).',
  Access0x1ProvenanceRegistry__RepoNotClaimed:
    'This repo has not been claimed yet — claim it first, then anchor a release.',
  Access0x1ProvenanceRegistry__NotRepoOwner:
    'Only the wallet that claimed this repo can anchor a release. Connect that wallet.',
  Access0x1ProvenanceRegistry__NotProposedOwner:
    'This wallet is not the proposed new owner of the repo.',
  Access0x1ProvenanceRegistry__ZeroAddress: 'A zero address is not allowed here.',
  Access0x1ProvenanceRegistry__NoRelease: 'No release has been anchored for this repo yet.',
  Access0x1ProvenanceRegistry__IndexOutOfBounds: 'That release index is out of range.',
  Access0x1ProvenanceRegistry__SignatureExpired: 'The signature deadline has passed — try again.',
  Access0x1ProvenanceRegistry__BadSignature: 'The signature did not match the repo owner.',
  Access0x1ProvenanceRegistry__BadNonce: 'The signature nonce is out of order — refresh and retry.',
}

/**
 * Turn a thrown viem/wallet error into a clean, human reason string.
 *
 * Surfaces, in order: a known registry custom error (by name), a user-rejected
 * signature, an insufficient-funds hint, then viem's own short message, falling
 * back to a generic line. Never leaks a stack trace into the UI.
 */
export function humanizeAdminRevert(err: unknown): string {
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: unknown }).message)
      : String(err)

  for (const [name, friendly] of Object.entries(KNOWN_REVERTS)) {
    if (message.includes(name)) return friendly
  }
  if (/User rejected|rejected the request|denied transaction|User denied/i.test(message)) {
    return 'You rejected the request in your wallet.'
  }
  if (/insufficient funds/i.test(message)) {
    return 'Insufficient funds for gas on this testnet — top up the connected wallet.'
  }
  // viem attaches a concise `shortMessage` to its errors; prefer it when present.
  const short =
    typeof err === 'object' && err !== null && 'shortMessage' in err
      ? String((err as { shortMessage: unknown }).shortMessage)
      : null
  if (short) return short
  // Otherwise return the first line of the raw message (no stack trace).
  return message.split('\n')[0] || 'The transaction failed. Please try again.'
}

// ── The three on-chain actions (viem wrappers) ───────────────────────────────
//
// Each takes the connected wallet client (from the browser wallet) + a public
// client (for the receipt), runs the tx, and waits for it to be mined. They are
// thin by design: the page owns all UI state (pending / hash / error); these own
// only the chain calls.

/** The vendored registry abi, re-exported for the page's reads/writes. */
export const REGISTRY_ABI = PROVENANCE_REGISTRY_ABI as Abi

/** The registry's public creation bytecode (deploy input). */
export const REGISTRY_BYTECODE: Hex = PROVENANCE_REGISTRY_BYTECODE

/**
 * The constructor args for the registry. Mirrors the artifact's constructor
 * `(string name, string version)` — the EIP-712 domain for its signed-anchor
 * path. The web app never uses the signed path, so these are plain, stable
 * domain labels; they do NOT affect the un-signed `claimRepo` / `anchorRelease`
 * the admin page calls.
 */
export const REGISTRY_CONSTRUCTOR_ARGS = ['Access0x1ProvenanceRegistry', '1'] as const

/**
 * Deploy a fresh Access0x1ProvenanceRegistry from the connected browser wallet.
 *
 * Calls viem's `walletClient.deployContract({ abi, bytecode, args })`, waits for
 * the receipt, and returns the new contract address + the deploy tx hash. NO
 * keystore, NO server — the owner signs the deploy in their own wallet.
 *
 * @throws when the wallet has no account, or the receipt carries no contract
 *   address (a failed deploy) — surfaced via {@link humanizeAdminRevert}.
 */
export async function deployRegistry(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<{ txHash: Hash; address: Address }> {
  const account = walletClient.account
  if (!account) throw new Error('Wallet has no account connected')

  const txHash = await walletClient.deployContract({
    account,
    chain: walletClient.chain,
    abi: REGISTRY_ABI,
    bytecode: REGISTRY_BYTECODE,
    args: [...REGISTRY_CONSTRUCTOR_ARGS],
  })

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  const address = receipt.contractAddress
  if (!address) {
    throw new Error('Deploy mined but no contract address was returned — the deploy reverted.')
  }
  return { txHash, address }
}

/**
 * Claim a repo on the registry — `claimRepo(repoId)`. First-claim-wins; reverts
 * `Access0x1ProvenanceRegistry__RepoAlreadyClaimed` if already taken. Waits for
 * the receipt before returning the tx hash.
 */
export async function claimRepo(
  walletClient: WalletClient,
  publicClient: PublicClient,
  registry: Address,
  repoId: Hex,
): Promise<{ txHash: Hash }> {
  const account = walletClient.account
  if (!account) throw new Error('Wallet has no account connected')

  const txHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'claimRepo',
    args: [repoId],
  })
  await publicClient.waitForTransactionReceipt({ hash: txHash })
  return { txHash }
}

/**
 * Anchor a release under a claimed repo —
 * `anchorRelease(repoId, cid, tag, merkleRoot)`. Only the repo owner may call it
 * (else `Access0x1ProvenanceRegistry__NotRepoOwner`). Waits for the receipt
 * before returning the tx hash.
 */
export async function anchorRelease(
  walletClient: WalletClient,
  publicClient: PublicClient,
  registry: Address,
  repoId: Hex,
  input: AnchorInput,
): Promise<{ txHash: Hash }> {
  const account = walletClient.account
  if (!account) throw new Error('Wallet has no account connected')

  const txHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'anchorRelease',
    args: [repoId, input.cid, input.tag, input.merkleRoot],
  })
  await publicClient.waitForTransactionReceipt({ hash: txHash })
  return { txHash }
}
