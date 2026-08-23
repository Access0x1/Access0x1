/**
 * registrar.ts — buy a real .eth name from inside the app ("Own your name").
 *
 * The ENS .eth registration protocol is a strict two-transaction commit/reveal
 * (anti-frontrunning) with a mandatory wait between them:
 *
 *   1. available(label)               — is the name registrable at all?
 *   2. rentPrice(label, duration)     — USD-oracle price, returned in wei.
 *   3. makeCommitment(...) [view]     — the CONTRACT computes the commitment
 *                                       hash. We never re-implement the hash
 *                                       locally: a drifted encoding would burn
 *                                       the buyer's commit gas silently.
 *   4. commit(commitment)             — tx 1, from the CONNECTED wallet.
 *   5. wait ≥ minCommitmentAge (60s)  — enforced on-chain; registering earlier
 *      and ≤ maxCommitmentAge (24h)     REVERTS. The step engine (ownName.ts)
 *                                       enforces it client-side too.
 *   6. register{value}(...)           — tx 2, same wallet, same params, same
 *                                       secret. Overpayment is refunded by the
 *                                       controller, so the value carries a small
 *                                       buffer against oracle drift between
 *                                       quote and mine.
 *
 * VERSION TARGET — ENSv1 controller, deliberately. This client speaks to the
 * ETHRegistrarController that is DEPLOYED AND REGISTERABLE today (Sepolia + the
 * live .eth registrar). The ENSv2 ETH Registrar changes the surface — ERC20
 * payment via approve/safeTransferFrom instead of msg.value, a (subregistry,
 * referrer) pair instead of (data[], reverseRecord, fuses), isAvailable/
 * getRegisterPrice instead of available/rentPrice, $8/yr base with multi-year
 * discounts, 28-day grace — but ENS's own docs mark those contracts "not yet
 * final and may change prior to mainnet deployment". We do not build against a
 * moving interface (law 4: nothing claimed that isn't live). When v2 finalizes,
 * the adapter is contained: registrationArgs() is the single argument builder
 * both txs share, and the step engine (ownName.ts) carries over UNCHANGED —
 * v2 keeps the same commit → MIN_COMMITMENT_AGE (60s) → register ≤ 24h window.
 *
 * DOCTRINE:
 *   - Env-gated + fail-soft (law 1): no controller address configured ⇒ the
 *     whole seam reports unconfigured and the UI never shows "Buy".
 *   - No hardcoded addresses (law 3): the controller/resolver come from
 *     NEXT_PUBLIC_ENS_REGISTRAR_* env, marked CONFIRM from official ENS docs.
 *   - Testnet-only (law 5): the default chain is Ethereum Sepolia (11155111),
 *     where ENS runs a full deployment. Nothing here ever claims mainnet.
 *   - Zero custody: both transactions are SIGNED BY THE BUYER's connected
 *     wallet. No server key touches the flow; there is no server route at all.
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  http,
  isAddress,
} from 'viem'
import { normalize } from 'viem/ens'
import { sepolia } from 'viem/chains'

/** Minimal ABI of ETHRegistrarController — the interface is stable; only the ADDRESS is env. */
export const ETH_REGISTRAR_CONTROLLER_ABI = [
  {
    name: 'available',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'rentPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'duration', type: 'uint256' },
    ],
    outputs: [
      {
        components: [
          { name: 'base', type: 'uint256' },
          { name: 'premium', type: 'uint256' },
        ],
        type: 'tuple',
      },
    ],
  },
  {
    name: 'makeCommitment',
    type: 'function',
    stateMutability: 'pure',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'duration', type: 'uint256' },
      { name: 'secret', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
      { name: 'data', type: 'bytes[]' },
      { name: 'reverseRecord', type: 'bool' },
      { name: 'ownerControlledFuses', type: 'uint16' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'minCommitmentAge',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'maxCommitmentAge',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'commit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'commitment', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'register',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'duration', type: 'uint256' },
      { name: 'secret', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
      { name: 'data', type: 'bytes[]' },
      { name: 'reverseRecord', type: 'bool' },
      { name: 'ownerControlledFuses', type: 'uint16' },
    ],
    outputs: [],
  },
] as const

/** ENS minimum registration duration (28 days, from the controller). */
export const MIN_REGISTRATION_SECONDS = 28 * 24 * 60 * 60
/** Our default purchase: one year (365.25 days, matching ENS's own math). */
export const DEFAULT_REGISTRATION_SECONDS = 31_557_600
/** Fallbacks when the chain reads fail — the controller's deployed values. */
export const FALLBACK_MIN_COMMITMENT_AGE_S = 60
export const FALLBACK_MAX_COMMITMENT_AGE_S = 86_400
/**
 * Safety margin added on top of minCommitmentAge before we OFFER register:
 * covers block-timestamp granularity + client clock skew. Registering the
 * instant the 60s elapses risks an on-chain revert on a slow block.
 */
export const COMMITMENT_SAFETY_MARGIN_S = 12
/**
 * Register value = quoted rent + 5% buffer. The price is USD-denominated and
 * converted to ETH by oracle at execution; a quote can drift by the time tx 2
 * mines. The controller REFUNDS everything above the true price, so the buffer
 * costs nothing — running exact-value risks an InsufficientValue revert.
 */
export const REGISTER_VALUE_BUFFER_NUM = 105n
export const REGISTER_VALUE_BUFFER_DEN = 100n

/** The env-derived registrar config, or null when the seam is OFF. */
export interface RegistrarConfig {
  /** ETHRegistrarController address — CONFIRM from official ENS docs (Sepolia). */
  controller: Address
  /** Chain the registrar runs on. Testnet-only: defaults to Sepolia (11155111). */
  chainId: number
  /**
   * Public resolver set on the name at registration (enables records + reverse).
   * Zero address ⇒ register bare: no records, and reverseRecord MUST be false.
   */
  resolver: Address
  /** RPC override for the registrar chain (blank ⇒ the chain's public default). */
  rpcUrl?: string
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/**
 * Read the registrar config from env. Blank/invalid controller ⇒ null (the
 * seam is dormant; the UI hides "Own your name" — law 1, never a crash).
 *
 * The default branch reads each NEXT_PUBLIC_ var as a LITERAL property access:
 * Next.js inlines NEXT_PUBLIC_* into the client bundle only for the literal
 * `process.env.NEXT_PUBLIC_X` form — a dynamic env[name] lookup ships as
 * undefined in the browser and the seam would silently never turn on.
 */
export function registrarConfig(env?: Record<string, string | undefined>): RegistrarConfig | null {
  env ??= {
    NEXT_PUBLIC_ENS_REGISTRAR_CONTROLLER: process.env.NEXT_PUBLIC_ENS_REGISTRAR_CONTROLLER,
    NEXT_PUBLIC_ENS_REGISTRAR_CHAIN_ID: process.env.NEXT_PUBLIC_ENS_REGISTRAR_CHAIN_ID,
    NEXT_PUBLIC_ENS_REGISTRAR_RESOLVER: process.env.NEXT_PUBLIC_ENS_REGISTRAR_RESOLVER,
    NEXT_PUBLIC_ENS_REGISTRAR_RPC_URL: process.env.NEXT_PUBLIC_ENS_REGISTRAR_RPC_URL,
  }
  const controller = (env.NEXT_PUBLIC_ENS_REGISTRAR_CONTROLLER ?? '').trim()
  if (!isAddress(controller)) return null
  const rawChain = (env.NEXT_PUBLIC_ENS_REGISTRAR_CHAIN_ID ?? '').trim()
  const chainId = rawChain.length > 0 ? Number(rawChain) : sepolia.id
  if (!Number.isInteger(chainId) || chainId <= 0) return null
  const rawResolver = (env.NEXT_PUBLIC_ENS_REGISTRAR_RESOLVER ?? '').trim()
  const resolver = isAddress(rawResolver) ? (rawResolver as Address) : ZERO_ADDRESS
  const rpcUrl = (env.NEXT_PUBLIC_ENS_REGISTRAR_RPC_URL ?? '').trim() || undefined
  return { controller: controller as Address, chainId, resolver, rpcUrl }
}

/** True when the in-app purchase seam is configured (drives UI visibility). */
export function isRegistrarConfigured(env?: Record<string, string | undefined>): boolean {
  return registrarConfig(env) !== null
}

/** Why a label can't be registered, in copy the UI shows verbatim. */
export type LabelProblem =
  | 'empty'
  | 'contains_dot'
  | 'too_short'
  | 'not_normalizable'

/** A validated, normalized .eth label (the part before ".eth"). */
export interface ValidLabel {
  ok: true
  /** ENSIP-15 normalized label — ALWAYS use this, never the raw input. */
  label: string
}

/** Validate + normalize a requested label. Pure; never throws. */
export function validateLabel(raw: string): ValidLabel | { ok: false; problem: LabelProblem } {
  const trimmed = raw.trim().toLowerCase().replace(/\.eth$/, '')
  if (trimmed.length === 0) return { ok: false, problem: 'empty' }
  if (trimmed.includes('.')) return { ok: false, problem: 'contains_dot' }
  let label: string
  try {
    label = normalize(trimmed)
  } catch {
    return { ok: false, problem: 'not_normalizable' }
  }
  // .eth registrar minimum is 3 characters (1–2 char names are reserved).
  if ([...label].length < 3) return { ok: false, problem: 'too_short' }
  return { ok: true, label }
}

/** Clamp a requested duration to the controller's minimum (28 days). */
export function clampDuration(seconds: number): bigint {
  const s = Number.isFinite(seconds) ? Math.floor(seconds) : DEFAULT_REGISTRATION_SECONDS
  return BigInt(Math.max(s, MIN_REGISTRATION_SECONDS))
}

/** The register tx value for a quoted rent: quote + refundable 5% buffer. */
export function registerValue(totalRentWei: bigint): bigint {
  return (totalRentWei * REGISTER_VALUE_BUFFER_NUM) / REGISTER_VALUE_BUFFER_DEN
}

/** A fresh 32-byte commitment secret from the platform CSPRNG. */
export function randomSecret(): Hex {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex
}

/** Everything both transactions must agree on. One drifted field ⇒ on-chain revert. */
export interface RegistrationParams {
  label: string
  owner: Address
  durationSeconds: bigint
  secret: Hex
  resolver: Address
  /** Resolver multicall data (e.g. setAddr) — empty when resolver is zero. */
  data: readonly Hex[]
  /** Set the reverse record (primary name) in the same tx. Needs a resolver. */
  reverseRecord: boolean
}

/**
 * Normalize registration inputs into the exact argument tuple BOTH txs use.
 * Central because the #1 commit/reveal bug is the two transactions computing
 * their arguments independently and drifting (⇒ CommitmentNotFound revert).
 */
export function registrationArgs(p: RegistrationParams) {
  if (p.resolver === ZERO_ADDRESS && (p.data.length > 0 || p.reverseRecord)) {
    throw new Error(
      'registrar: records/reverseRecord require a resolver — configure NEXT_PUBLIC_ENS_REGISTRAR_RESOLVER or register bare.',
    )
  }
  return [
    p.label,
    p.owner,
    p.durationSeconds,
    p.secret,
    p.resolver,
    p.data as Hex[],
    p.reverseRecord,
    0, // ownerControlledFuses — we never restrict the buyer's own name
  ] as const
}

/** A viem public client on the registrar chain (reads only; txs go via the wallet). */
export function registrarClient(cfg: RegistrarConfig): PublicClient {
  return createPublicClient({
    chain: cfg.chainId === sepolia.id ? sepolia : { ...sepolia, id: cfg.chainId },
    transport: http(cfg.rpcUrl),
  }) as PublicClient
}

/** A rent quote for label × duration, in wei of the registrar chain's ETH. */
export interface RentQuote {
  baseWei: bigint
  premiumWei: bigint
  totalWei: bigint
  /** What the register tx should send: total + refundable buffer. */
  valueWei: bigint
}

/** Read availability from the controller (step 1 of the protocol). */
export async function checkAvailable(
  client: Pick<PublicClient, 'readContract'>,
  cfg: RegistrarConfig,
  label: string,
): Promise<boolean> {
  return (await client.readContract({
    address: cfg.controller,
    abi: ETH_REGISTRAR_CONTROLLER_ABI,
    functionName: 'available',
    args: [label],
  })) as boolean
}

/** Read the rent quote from the controller (step 2). */
export async function quoteRent(
  client: Pick<PublicClient, 'readContract'>,
  cfg: RegistrarConfig,
  label: string,
  durationSeconds: bigint,
): Promise<RentQuote> {
  const price = (await client.readContract({
    address: cfg.controller,
    abi: ETH_REGISTRAR_CONTROLLER_ABI,
    functionName: 'rentPrice',
    args: [label, durationSeconds],
  })) as { base: bigint; premium: bigint }
  const totalWei = price.base + price.premium
  return { baseWei: price.base, premiumWei: price.premium, totalWei, valueWei: registerValue(totalWei) }
}

/** Ask the CONTRACT for the commitment hash (step 3) — never computed locally. */
export async function makeCommitment(
  client: Pick<PublicClient, 'readContract'>,
  cfg: RegistrarConfig,
  p: RegistrationParams,
): Promise<Hex> {
  return (await client.readContract({
    address: cfg.controller,
    abi: ETH_REGISTRAR_CONTROLLER_ABI,
    functionName: 'makeCommitment',
    args: registrationArgs(p),
  })) as Hex
}

/** Read the controller's commitment-age window, with deployed-value fallbacks. */
export async function commitmentWindow(
  client: Pick<PublicClient, 'readContract'>,
  cfg: RegistrarConfig,
): Promise<{ minAgeS: number; maxAgeS: number }> {
  try {
    const [min, max] = await Promise.all([
      client.readContract({
        address: cfg.controller,
        abi: ETH_REGISTRAR_CONTROLLER_ABI,
        functionName: 'minCommitmentAge',
      }),
      client.readContract({
        address: cfg.controller,
        abi: ETH_REGISTRAR_CONTROLLER_ABI,
        functionName: 'maxCommitmentAge',
      }),
    ])
    return { minAgeS: Number(min), maxAgeS: Number(max) }
  } catch {
    return { minAgeS: FALLBACK_MIN_COMMITMENT_AGE_S, maxAgeS: FALLBACK_MAX_COMMITMENT_AGE_S }
  }
}

/** The commit transaction request (step 4) — signed by the connected wallet. */
export function buildCommitTx(cfg: RegistrarConfig, commitment: Hex) {
  return {
    address: cfg.controller,
    abi: ETH_REGISTRAR_CONTROLLER_ABI,
    functionName: 'commit' as const,
    args: [commitment] as const,
    chainId: cfg.chainId,
  }
}

/** The register transaction request (step 6) — same wallet, same params, + value. */
export function buildRegisterTx(cfg: RegistrarConfig, p: RegistrationParams, valueWei: bigint) {
  return {
    address: cfg.controller,
    abi: ETH_REGISTRAR_CONTROLLER_ABI,
    functionName: 'register' as const,
    args: registrationArgs(p),
    value: valueWei,
    chainId: cfg.chainId,
  }
}
