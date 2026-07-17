/**
 * estimate.ts — "what would it have cost if it just ran": pure EVM gas math
 * for storing an uploaded SVG on-chain, computed from first principles.
 *
 * NOTHING here touches the network. Every number derives from published
 * protocol constants (cited per constant below), and every strategy returns a
 * line-by-line breakdown carrying its own arithmetic — the estimate is
 * PROVABLE by reading it, not trusted. The live cross-check (a real
 * `eth_estimateGas` against a testnet node) lives in the API route; this
 * module is deliberately pure + synchronous so it unit-tests offline against
 * hand-computed vectors (the logo.ts discipline).
 *
 * Four honest strategies, in the order a reviewer would rank them:
 *   1. calldata-anchor — the bytes ride as tx calldata; only a keccak-256
 *      fingerprint is stored (the ProvenanceRegistry shape). Cheapest.
 *   2. sstore2        — the bytes become CONTRACT CODE (the SSTORE2 pattern,
 *      200 gas/byte deposit), chunked at the EIP-170 code-size ceiling.
 *   3. tokenuri-mint  — an ERC-721 mint storing a base64 data-URI string
 *      (the Receivables.mint / TicketToken.mint shape). The 4/3 base64
 *      expansion is paid in storage.
 *   4. storage-slots  — raw SSTOREs, 32 bytes per slot. The anti-pattern,
 *      shown because it is what "put the image on-chain" naively means.
 *
 * Each strategy is computed under BOTH calldata-pricing regimes:
 *   - legacy (EIP-2028): 16 gas per nonzero calldata byte, 4 per zero byte;
 *   - EIP-7623 (Prague, live on Ethereum/OP-Stack testnets since 2025): the
 *     same 16/4 standard cost, but a data-heavy tx pays at least
 *     `21000 + 10 × tokens` where tokens = zero_bytes + 4 × nonzero_bytes.
 *     The floor arm is PURELY 10 × tokens; the standard arm carries the
 *     create surcharge + execution (implemented exactly that way below).
 * The delta between the two — and which one the LIVE node reports — is part
 * of the demo: the math predicts, the chain confirms. Chain honesty notes:
 *   - Arbitrum chains deliberately do NOT enable EIP-7623 (ArbOS 40+ ship
 *     Pectra parity without it) — there the legacy number is the right one.
 *   - OP-Stack chains (Base/OP Sepolia) charge an L1 data fee ON TOP of the
 *     L2 gas modeled here; the estimate covers L2 execution gas only.
 *   - EIP-7976 (proposed, Glamsterdam-era) would raise the floor to
 *     15/token — the FLOOR_PER_TOKEN constant is fork-dependent by design.
 *
 * Honesty note (law #4): totals cover the spec-derivable terms and label the
 * small contract-dispatch overhead (~hundreds of gas per call) as excluded —
 * a LOWER BOUND is stated as one, never dressed up as exact.
 */

/** Protocol gas constants. Each value cites its source of authority. */
export const GAS = {
  /** Intrinsic cost of any transaction (yellow paper G_transaction). */
  TX_BASE: 21_000n,
  /** Extra intrinsic cost of a contract-CREATING transaction (G_txcreate). */
  TX_CREATE: 32_000n,
  /** Calldata: gas per ZERO byte (EIP-2028 / G_txdatazero). */
  CALLDATA_ZERO: 4n,
  /** Calldata: gas per NONZERO byte (EIP-2028 / G_txdatanonzero). */
  CALLDATA_NONZERO: 16n,
  /**
   * EIP-7623 floor: a data-heavy tx pays at least FLOOR_PER_TOKEN per
   * calldata token, where tokens = zero_bytes + 4 × nonzero_bytes.
   */
  FLOOR_PER_TOKEN: 10n,
  /** EIP-7623 standard cost per calldata token (= the legacy 16/4 restated). */
  STANDARD_PER_TOKEN: 4n,
  /** Cold SSTORE of a fresh (zero → nonzero) slot: 20,000 (EIP-3529 SSTORE_SET) + 2,100 cold access (EIP-2929). */
  SSTORE_SET_COLD: 22_100n,
  /** Code-deposit cost per byte of deployed runtime code (yellow paper G_codedeposit). */
  CODE_DEPOSIT_PER_BYTE: 200n,
  /** Max deployed runtime-code size in bytes (EIP-170). */
  MAX_CODE_SIZE: 24_576,
  /** Initcode cost per 32-byte word (EIP-3860 G_initcodeword). */
  INITCODE_WORD: 2n,
  /** LOG opcode: base + per-topic + per-data-byte (yellow paper G_log*). */
  LOG_BASE: 375n,
  LOG_TOPIC: 375n,
  LOG_DATA_BYTE: 8n,
  /** KECCAK256: 30 base + 6 per 32-byte word (yellow paper G_keccak256*). */
  KECCAK_BASE: 30n,
  KECCAK_WORD: 6n,
  /** Memory expansion: 3 gas per word + words²/512 quadratic term (yellow paper). */
  MEMORY_WORD: 3n,
  /** CALLDATACOPY/CODECOPY per-word copy cost (yellow paper G_copy = 3/word). */
  COPY_WORD: 3n,
} as const

/**
 * The SSTORE2 pattern (solmate/0xSequence): runtime code = 1 STOP byte + the
 * payload, so one contract carries at most EIP-170's 24,576 − 1 data bytes.
 * Its creation code is an 11-byte prelude that CODECOPYs the payload and
 * RETURNs it as the runtime.
 */
export const SSTORE2_DATA_PER_CONTRACT = GAS.MAX_CODE_SIZE - 1
const SSTORE2_PRELUDE_BYTES = 11n
const SSTORE2_STOP_BYTE = 1n

/** The data-URI prefix a base64 SVG tokenURI carries (26 ASCII bytes). */
export const SVG_DATA_URI_PREFIX = 'data:image/svg+xml;base64,'

/** Byte-level shape of a payload — everything the calldata math needs. */
export interface ByteStats {
  /** Total byte length. */
  bytes: number
  /** Count of 0x00 bytes (4 gas each as calldata). */
  zeroBytes: number
  /** Count of nonzero bytes (16 gas each as calldata). */
  nonzeroBytes: number
}

/** One provable line of a strategy's arithmetic. */
export interface BreakdownLine {
  /** What the term is (e.g. "Calldata — nonzero bytes"). */
  label: string
  /** The exact arithmetic, human-readable (e.g. "16 gas × 3,412 bytes"). */
  formula: string
  /** The term's gas, exactly as the formula evaluates. */
  gas: bigint
}

/** A full as-if-it-ran estimate for one storage strategy. */
export interface StrategyEstimate {
  strategy: 'calldata-anchor' | 'sstore2' | 'tokenuri-mint' | 'storage-slots'
  title: string
  /** One-sentence honest description of what the strategy actually stores. */
  description: string
  /** How many transactions the payload needs (chunking at protocol ceilings). */
  txCount: number
  /** Total gas under legacy EIP-2028 calldata pricing. */
  gasLegacy: bigint
  /** Total gas under EIP-7623 floor pricing (≥ gasLegacy only when the floor binds). */
  gasFloor: bigint
  /** True when EIP-7623's floor is the binding term for at least one tx. */
  floorBinds: boolean
  /** The provable arithmetic, line by line (legacy-regime terms). */
  breakdown: BreakdownLine[]
  /** Honest caveats: what the total excludes or approximates. */
  notes: string[]
}

/** Count zero / nonzero bytes — the two calldata price classes. */
export function byteStats(data: Uint8Array): ByteStats {
  let zeroBytes = 0
  for (const b of data) if (b === 0) zeroBytes++
  return { bytes: data.length, zeroBytes, nonzeroBytes: data.length - zeroBytes }
}

/** UTF-8 encode a string and count its calldata byte classes. */
export function svgByteStats(svg: string): ByteStats {
  return byteStats(new TextEncoder().encode(svg))
}

/** EIP-7623 calldata tokens: zero_bytes + 4 × nonzero_bytes. */
export function calldataTokens(stats: ByteStats): bigint {
  return BigInt(stats.zeroBytes) + 4n * BigInt(stats.nonzeroBytes)
}

/** Legacy (EIP-2028) calldata gas: 4/zero + 16/nonzero. */
export function calldataGas(stats: ByteStats): bigint {
  return (
    GAS.CALLDATA_ZERO * BigInt(stats.zeroBytes) + GAS.CALLDATA_NONZERO * BigInt(stats.nonzeroBytes)
  )
}

/** KECCAK256 cost of hashing `bytes` bytes already in memory. */
export function keccakGas(bytes: number): bigint {
  return GAS.KECCAK_BASE + GAS.KECCAK_WORD * BigInt(words(bytes))
}

/** Memory-expansion cost to touch `bytes` bytes: 3·words + ⌊words²/512⌋. */
export function memoryGas(bytes: number): bigint {
  const w = BigInt(words(bytes))
  return GAS.MEMORY_WORD * w + (w * w) / 512n
}

/** CALLDATACOPY/CODECOPY cost to bring `bytes` bytes into memory: 3·words. */
export function copyGas(bytes: number): bigint {
  return GAS.COPY_WORD * BigInt(words(bytes))
}

/** 32-byte words needed to hold `bytes` bytes. */
function words(bytes: number): number {
  return Math.ceil(bytes / 32)
}

/** Base64 length of `bytes` raw bytes: 4 chars per 3-byte group, padded. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/** Thousands-separated decimal for formulas + UI ("1234567" → "1,234,567"). */
export function formatGas(value: bigint | number): string {
  return value.toLocaleString('en-US')
}

/**
 * One transaction's worth of work, kept as (calldata stats, execution gas) so
 * BOTH pricing regimes can be derived from the same terms:
 *   legacy = TX_BASE [+ TX_CREATE] + 16/4·calldata + execution
 *   7623   = TX_BASE [+ TX_CREATE] + max(4·tokens + execution, 10·tokens)
 */
interface TxTerms {
  data: ByteStats
  execGas: bigint
  isCreate: boolean
}

function txLegacy(tx: TxTerms): bigint {
  const create = tx.isCreate ? GAS.TX_CREATE : 0n
  return GAS.TX_BASE + create + calldataGas(tx.data) + tx.execGas
}

function txFloor(tx: TxTerms): { gas: bigint; bound: boolean } {
  const create = tx.isCreate ? GAS.TX_CREATE : 0n
  const tokens = calldataTokens(tx.data)
  const standard = GAS.STANDARD_PER_TOKEN * tokens + create + tx.execGas
  const floor = GAS.FLOOR_PER_TOKEN * tokens
  const bound = floor > standard
  return { gas: GAS.TX_BASE + (bound ? floor : standard), bound }
}

function totals(txs: TxTerms[]): { gasLegacy: bigint; gasFloor: bigint; floorBinds: boolean } {
  let gasLegacy = 0n
  let gasFloor = 0n
  let floorBinds = false
  for (const tx of txs) {
    gasLegacy += txLegacy(tx)
    const f = txFloor(tx)
    gasFloor += f.gas
    floorBinds = floorBinds || f.bound
  }
  return { gasLegacy, gasFloor, floorBinds }
}

/** Shared breakdown lines for a payload travelling as calldata. */
function calldataLines(stats: ByteStats, what: string): BreakdownLine[] {
  return [
    {
      label: `Calldata — nonzero bytes (${what})`,
      formula: `${formatGas(GAS.CALLDATA_NONZERO)} gas × ${formatGas(stats.nonzeroBytes)} bytes (EIP-2028)`,
      gas: GAS.CALLDATA_NONZERO * BigInt(stats.nonzeroBytes),
    },
    {
      label: `Calldata — zero bytes (${what})`,
      formula: `${formatGas(GAS.CALLDATA_ZERO)} gas × ${formatGas(stats.zeroBytes)} bytes (EIP-2028)`,
      gas: GAS.CALLDATA_ZERO * BigInt(stats.zeroBytes),
    },
  ]
}

/**
 * Strategy 1 — calldata anchor (the ProvenanceRegistry shape): the SVG rides
 * as calldata, the contract keccak-hashes it, stores the 32-byte fingerprint
 * in one fresh slot, and emits an event carrying the hash. The bytes live in
 * the chain's history (any node can re-derive + verify the hash); only the
 * fingerprint lives in state.
 */
export function estimateCalldataAnchor(stats: ByteStats): StrategyEstimate {
  const hash = keccakGas(stats.bytes)
  const copy = copyGas(stats.bytes)
  const mem = memoryGas(stats.bytes)
  const log = GAS.LOG_BASE + 2n * GAS.LOG_TOPIC + GAS.LOG_DATA_BYTE * 32n
  const execGas = hash + copy + mem + GAS.SSTORE_SET_COLD + log
  const tx: TxTerms = { data: stats, execGas, isCreate: false }
  const t = totals([tx])
  return {
    strategy: 'calldata-anchor',
    title: 'Publish + fingerprint (calldata anchor)',
    description:
      'The SVG travels as transaction calldata; only its keccak-256 fingerprint is stored on-chain. The bytes are permanently re-derivable from history.',
    txCount: 1,
    ...t,
    breakdown: [
      { label: 'Transaction base', formula: `${formatGas(GAS.TX_BASE)} gas (intrinsic)`, gas: GAS.TX_BASE },
      ...calldataLines(stats, 'the SVG'),
      {
        label: 'Copy calldata into memory (to hash it)',
        formula: `${formatGas(GAS.COPY_WORD)} gas × ${formatGas(words(stats.bytes))} words (CALLDATACOPY, G_copy)`,
        gas: copy,
      },
      {
        label: 'keccak-256 fingerprint',
        formula: `${formatGas(GAS.KECCAK_BASE)} + ${formatGas(GAS.KECCAK_WORD)} gas × ${formatGas(words(stats.bytes))} words`,
        gas: hash,
      },
      {
        label: 'Memory expansion',
        formula: `3 gas × ${formatGas(words(stats.bytes))} words + ⌊words²/512⌋`,
        gas: mem,
      },
      {
        label: 'Store the 32-byte anchor (1 fresh slot)',
        formula: `${formatGas(GAS.SSTORE_SET_COLD)} gas (20,000 SSTORE_SET + 2,100 cold, EIP-2929/3529)`,
        gas: GAS.SSTORE_SET_COLD,
      },
      {
        label: 'Anchor event (2 topics, 32 data bytes)',
        formula: `375 + 375 × 2 topics + 8 gas × 32 bytes`,
        gas: log,
      },
    ],
    notes: [
      'Lower bound: excludes the contract’s dispatch overhead (roughly a few hundred gas).',
      'The image itself is NOT readable by other contracts — only provable against the stored hash.',
    ],
  }
}

/**
 * Strategy 2 — SSTORE2: the bytes are deployed AS contract runtime code
 * (1 STOP byte + payload), readable back with EXTCODECOPY. Chunked at the
 * EIP-170 ceiling: one create-transaction per 24,575-byte chunk.
 */
export function estimateSstore2(stats: ByteStats): StrategyEstimate {
  const chunkSizes = splitChunks(stats.bytes, SSTORE2_DATA_PER_CONTRACT)
  const txCount = chunkSizes.length
  // Byte classes distribute proportionally across chunks; exactness only
  // matters in aggregate, so charge each chunk its share and keep the exact
  // totals by building per-chunk stats that sum to the whole.
  const chunkStats = apportionStats(stats, chunkSizes)
  const txs: TxTerms[] = chunkStats.map((cs) => {
    const initcodeBytes = Number(SSTORE2_PRELUDE_BYTES + SSTORE2_STOP_BYTE) + cs.bytes
    const runtimeBytes = BigInt(cs.bytes) + SSTORE2_STOP_BYTE
    const execGas =
      GAS.CODE_DEPOSIT_PER_BYTE * runtimeBytes +
      GAS.INITCODE_WORD * BigInt(words(initcodeBytes)) +
      memoryGas(initcodeBytes)
    // The initcode (prelude + STOP + payload) is the create-tx's calldata.
    const data: ByteStats = {
      bytes: initcodeBytes,
      zeroBytes: cs.zeroBytes + Number(SSTORE2_STOP_BYTE),
      nonzeroBytes: cs.nonzeroBytes + Number(SSTORE2_PRELUDE_BYTES),
    }
    return { data, execGas, isCreate: true }
  })
  const t = totals(txs)
  const totalRuntime = BigInt(stats.bytes) + SSTORE2_STOP_BYTE * BigInt(txCount)
  const depositGas = GAS.CODE_DEPOSIT_PER_BYTE * totalRuntime
  return {
    strategy: 'sstore2',
    title: 'Store as contract code (SSTORE2)',
    description:
      'The SVG bytes are deployed as contract runtime code (readable on-chain via EXTCODECOPY), split across create-transactions at the EIP-170 24,576-byte code ceiling.',
    txCount,
    ...t,
    breakdown: [
      {
        label: `Transaction base × ${txCount} create tx${txCount === 1 ? '' : 's'}`,
        formula: `(${formatGas(GAS.TX_BASE)} + ${formatGas(GAS.TX_CREATE)} create surcharge) × ${txCount}`,
        gas: (GAS.TX_BASE + GAS.TX_CREATE) * BigInt(txCount),
      },
      ...calldataLines(
        {
          bytes: txs.reduce((n, tx) => n + tx.data.bytes, 0),
          zeroBytes: txs.reduce((n, tx) => n + tx.data.zeroBytes, 0),
          nonzeroBytes: txs.reduce((n, tx) => n + tx.data.nonzeroBytes, 0),
        },
        'initcode',
      ),
      {
        label: 'Code deposit (the bytes become code)',
        formula: `${formatGas(GAS.CODE_DEPOSIT_PER_BYTE)} gas × ${formatGas(totalRuntime)} runtime bytes`,
        gas: depositGas,
      },
      {
        label: 'Initcode words (EIP-3860) + memory',
        formula: `2 gas × initcode words + memory expansion, per chunk`,
        gas:
          txs.reduce((n, tx) => n + tx.execGas, 0n) - depositGas,
      },
    ],
    notes: [
      `Chunking: ${formatGas(stats.bytes)} bytes ÷ ${formatGas(SSTORE2_DATA_PER_CONTRACT)} bytes/contract → ${txCount} contract${txCount === 1 ? '' : 's'} (EIP-170, minus the 1-byte STOP guard).`,
      'Readable by other contracts; immutable once deployed; the dominant term is the 200 gas/byte code deposit.',
    ],
  }
}

/**
 * Strategy 3 — tokenURI mint (the Receivables.mint / TicketToken shape): an
 * ERC-721 is minted whose stored URI is the base64 data-URI of the SVG. The
 * base64 expansion (4/3 + 26-byte prefix) is paid in BOTH calldata and
 * storage; the mint's fixed slots (owner + balance) and Transfer event ride
 * along.
 */
export function estimateTokenUriMint(stats: ByteStats): StrategyEstimate {
  const uriBytes = SVG_DATA_URI_PREFIX.length + base64Length(stats.bytes)
  // base64 output is ASCII — every byte nonzero (calldata prices it at 16).
  const uriStats: ByteStats = { bytes: uriBytes, zeroBytes: 0, nonzeroBytes: uriBytes }
  // Solidity storage layout: a string ≤ 31 bytes packs its data + length into a
  // SINGLE slot; only a ≥ 32-byte string uses the long form (1 length slot +
  // ⌈n/32⌉ data slots). Any real SVG data-URI is well past 32 bytes, but pricing
  // the short case correctly keeps the estimate honest at the small edge.
  const uriSlots = uriBytes <= 31 ? 1 : 1 + words(uriBytes)
  const storeUri = GAS.SSTORE_SET_COLD * BigInt(uriSlots)
  const mintSlots = 2n * GAS.SSTORE_SET_COLD // owner + balance, both fresh
  const transferLog = GAS.LOG_BASE + 4n * GAS.LOG_TOPIC // Transfer: sig + 3 indexed topics
  const mem = memoryGas(uriBytes)
  const execGas = storeUri + mintSlots + transferLog + mem
  const t = totals([{ data: uriStats, execGas, isCreate: false }])
  return {
    strategy: 'tokenuri-mint',
    title: 'Mint with a base64 data-URI (tokenURI)',
    description:
      'An ERC-721 mint stores the SVG as a base64 data-URI string — wallet-renderable forever, but the 4/3 base64 expansion is paid in calldata and storage.',
    txCount: 1,
    ...t,
    breakdown: [
      { label: 'Transaction base', formula: `${formatGas(GAS.TX_BASE)} gas (intrinsic)`, gas: GAS.TX_BASE },
      {
        label: 'Base64 expansion',
        formula: `${formatGas(stats.bytes)} bytes → ⌈n/3⌉ × 4 + ${SVG_DATA_URI_PREFIX.length}-byte prefix = ${formatGas(uriBytes)} bytes`,
        gas: 0n,
      },
      ...calldataLines(uriStats, 'the data-URI'),
      {
        label: `Store the URI string (${formatGas(uriSlots)} fresh slots)`,
        formula: `${formatGas(GAS.SSTORE_SET_COLD)} gas × (1 length slot + ${formatGas(words(uriBytes))} data slots)`,
        gas: storeUri,
      },
      {
        label: 'Mint bookkeeping (owner + balance slots)',
        formula: `${formatGas(GAS.SSTORE_SET_COLD)} gas × 2 fresh slots`,
        gas: mintSlots,
      },
      {
        label: 'Transfer event (4 topics)',
        formula: `375 + 375 × 4 topics`,
        gas: transferLog,
      },
      {
        label: 'Memory expansion',
        formula: `3 gas × ${formatGas(words(uriBytes))} words + ⌊words²/512⌋`,
        gas: mem,
      },
    ],
    notes: [
      'Approximate at the edges: excludes ERC-721 dispatch + token-id bookkeeping beyond owner/balance (implementation-dependent, typically a few thousand gas).',
      'This is the shape of Receivables.mint on this rail — a real, deployed target. (TicketToken.mint shares the shape but ships in-repo only, not deployed.)',
    ],
  }
}

/**
 * Strategy 4 — raw storage slots: the naive "put the bytes in state" — one
 * fresh 32-byte slot per word plus the long-bytes length slot. Shown because
 * it is what "on-chain image" is usually assumed to mean, and why nobody
 * ships it.
 */
export function estimateStorageSlots(stats: ByteStats): StrategyEstimate {
  const slots = 1 + words(stats.bytes)
  const storeGas = GAS.SSTORE_SET_COLD * BigInt(slots)
  const mem = memoryGas(stats.bytes)
  const execGas = storeGas + mem + keccakGas(32) // base-slot hash for the data location
  const t = totals([{ data: stats, execGas, isCreate: false }])
  return {
    strategy: 'storage-slots',
    title: 'Raw storage slots (the naive way)',
    description:
      'Every 32 bytes of the SVG written into a fresh storage slot — fully readable state, and by far the most expensive honest option.',
    txCount: 1,
    ...t,
    breakdown: [
      { label: 'Transaction base', formula: `${formatGas(GAS.TX_BASE)} gas (intrinsic)`, gas: GAS.TX_BASE },
      ...calldataLines(stats, 'the SVG'),
      {
        label: `Fresh storage slots`,
        formula: `${formatGas(GAS.SSTORE_SET_COLD)} gas × (1 length slot + ${formatGas(words(stats.bytes))} data slots)`,
        gas: storeGas,
      },
      {
        label: 'Data-location hash + memory',
        formula: `keccak(32 bytes) + 3 gas × ${formatGas(words(stats.bytes))} words + ⌊words²/512⌋`,
        gas: mem + keccakGas(32),
      },
    ],
    notes: [
      'Lower bound: excludes dispatch and per-write slot-index arithmetic.',
      'A single tx this large may exceed the block gas limit on some chains — the txCount stays 1 here to keep the comparison honest about WHY this shape is avoided.',
    ],
  }
}

/** All four strategies for one payload, cheapest (by legacy gas) first. */
export function estimateAll(stats: ByteStats): StrategyEstimate[] {
  const all = [
    estimateCalldataAnchor(stats),
    estimateSstore2(stats),
    estimateTokenUriMint(stats),
    estimateStorageSlots(stats),
  ]
  return all.sort((a, b) => (a.gasLegacy < b.gasLegacy ? -1 : a.gasLegacy > b.gasLegacy ? 1 : 0))
}

/** Split `total` bytes into chunks of at most `max`, last chunk short. */
function splitChunks(total: number, max: number): number[] {
  if (total <= 0) return [0]
  const chunks: number[] = []
  let left = total
  while (left > 0) {
    const take = Math.min(left, max)
    chunks.push(take)
    left -= take
  }
  return chunks
}

/**
 * Distribute a payload's zero/nonzero byte counts across chunk sizes so the
 * per-chunk stats SUM EXACTLY to the whole AND every chunk stays feasible
 * (0 ≤ zeroBytes ≤ size, so nonzeroBytes is never negative). Each non-final
 * chunk takes its proportional share, CLAMPED so the chunks after it can still
 * absorb every remaining zero — the lower bound `zerosLeft − remainingAfter`
 * guarantees the final chunk's zeros never exceed its size. Without the clamp,
 * rounding-down on many mostly-zero chunks could leave more zeros than the last
 * chunk can hold and emit a negative nonzeroBytes.
 */
function apportionStats(stats: ByteStats, chunkSizes: number[]): ByteStats[] {
  const out: ByteStats[] = []
  let zerosLeft = stats.zeroBytes
  let bytesLeft = stats.bytes
  for (let i = 0; i < chunkSizes.length; i++) {
    const size = chunkSizes[i]
    const isLast = i === chunkSizes.length - 1
    let zeros: number
    if (isLast) {
      zeros = zerosLeft
    } else {
      const remainingAfter = bytesLeft - size
      const lower = Math.max(0, zerosLeft - remainingAfter)
      const upper = Math.min(size, zerosLeft)
      const target = bytesLeft > 0 ? Math.round((stats.zeroBytes * size) / stats.bytes) : 0
      zeros = Math.min(upper, Math.max(lower, target))
    }
    out.push({ bytes: size, zeroBytes: zeros, nonzeroBytes: size - zeros })
    zerosLeft -= zeros
    bytesLeft -= size
  }
  return out
}

/** Wei cost of `gas` at `gasPriceWei` — pure bigint, no rounding. */
export function weiCost(gas: bigint, gasPriceWei: bigint): bigint {
  return gas * gasPriceWei
}

/**
 * USD cost (8-decimal integer, the router's own unit) of a wei amount, given
 * how many wei one dollar buys (`weiPerUsd` — from the router's Chainlink
 * quote of $1.00 in the native token). Returns null when the rate is 0 —
 * fail-soft, never a division blow-up.
 */
export function usdCost8(wei: bigint, weiPerUsd: bigint): bigint | null {
  if (weiPerUsd <= 0n) return null
  return (wei * 100_000_000n) / weiPerUsd
}
