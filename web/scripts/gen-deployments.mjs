#!/usr/bin/env node
/**
 * gen-deployments.mjs — vendor the deployment-verification maps for the
 * "Deployments" dashboard (the code-diff view).
 *
 * Runs at build (and on demand) to turn the Foundry artifacts under the repo
 * root into two committed-as-generated TS modules the browser reads:
 *
 *   web/lib/deployments.ts      — per chain × contract: the DEPLOYED address
 *                                 (parsed from the CREATE txs in each chain's
 *                                 broadcast/run-latest.json) + chain display
 *                                 metadata (name, explorer base, RPC fallback).
 *   web/lib/currentBytecode.ts  — per contract: keccak256 of the CURRENT build's
 *                                 normalized runtime code, plus the immutable
 *                                 byte ranges to zero before comparing on-chain.
 *
 * DOCTRINE: no address is hand-typed (law #4 / guardrail #5) — every value is
 * read from the artifacts. The dashboard then re-derives the on-chain hash the
 * SAME way (lib/bytecodeDiff.ts) and compares, so MATCHES / DRIFTED / NOT-
 * DEPLOYED / NO-CODE is computed entirely client-side from real chain reads.
 *
 * Build note: this repo compiles with `bytecode_hash = "none"` +
 * `cbor_metadata = false`, so the artifacts carry NO CBOR metadata tail today.
 * The normalize step still strips a canonical `a264…0033` tail IF present (a
 * metadata-bearing on-chain code, or a future metadata-on build) and zeroes the
 * immutable ranges (which the constructor bakes into on-chain code but the
 * artifact leaves as zeros) — so the compare is correct in both worlds.
 *
 * Usage:
 *   node scripts/gen-deployments.mjs           # write both TS modules
 *   node scripts/gen-deployments.mjs --check    # exit 1 if the maps are stale
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256 } from 'viem'
import * as viemChains from 'viem/chains'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(WEB_ROOT, '..')
const BROADCAST_DIR = join(REPO_ROOT, 'broadcast', 'DeployAll.s.sol')
const OUT_DIR = join(REPO_ROOT, 'out')
const MIRROR_MANIFEST = join(REPO_ROOT, 'script', 'mirror-manifest.json')

/** Arc Testnet metadata — Arc is not a viem chain, so it is described inline. */
const ARC_TESTNET_ID = 5042002
const ARC_META = {
  name: 'Arc Testnet',
  // Explorer is NOT booth-confirmed for tx/address deep-links — left undefined
  // so the UI renders the address as plain text (law #4), never an invented link.
  explorer: undefined,
  rpc: 'https://rpc.testnet.arc.network',
}

/** A purely-local Anvil/Foundry chain id we never surface in the product view. */
const LOCAL_CHAIN_IDS = new Set([31337])

/**
 * Resolve display metadata for a chain id: prefer the canonical viem chain
 * object (so the name/explorer/RPC can never drift from the library), fall back
 * to the Arc inline profile, else a minimal "Chain <id>" stub. The explorer base
 * is normalized to drop any trailing slash; an explorer-less chain stays
 * undefined (address renders as plain text).
 */
function chainMeta(chainId) {
  if (chainId === ARC_TESTNET_ID) return ARC_META
  const chain = Object.values(viemChains).find(
    (c) => c && typeof c === 'object' && c.id === chainId,
  )
  if (!chain) return { name: `Chain ${chainId}`, explorer: undefined, rpc: undefined }
  const explorerUrl = chain.blockExplorers?.default?.url
  return {
    name: chain.name,
    explorer: explorerUrl ? explorerUrl.replace(/\/$/, '') : undefined,
    rpc: chain.rpcUrls?.default?.http?.[0],
  }
}

/**
 * Map a deployment's display name to the BUILD ARTIFACT that carries its runtime
 * code, so the bytecode-diff can fingerprint it. CREATE3 "mirror" entries are
 * named by their manifest key — an impl as `<Contract>.impl` (its own artifact),
 * a proxy as `<Contract>.proxy` (every UUPS proxy is an OpenZeppelin
 * `ERC1967Proxy`), and a standalone (e.g. `Access0x1Receiver`) as itself. Legacy
 * per-chain names (`Access0x1Router`, `ERC1967Proxy`) carry no suffix and resolve
 * to themselves, so their handling is byte-for-byte unchanged.
 */
function resolveArtifact(contractName) {
  if (contractName.endsWith('.impl')) return contractName.slice(0, -'.impl'.length)
  if (contractName.endsWith('.proxy')) return 'ERC1967Proxy'
  return contractName
}

/**
 * Build a lower-cased `{ mirror address -> manifest label }` map from
 * script/mirror-manifest.json — the canonical, deterministic CREATE3 address set
 * (identical on every chain, computed from the salt, not deployed). Returns an
 * empty Map when the manifest is absent. Used to NAME the contracts a CREATE3
 * deploy lands as nameless `additionalContracts` of the CreateX factory CALLs
 * (see {@link parseBroadcastData}).
 */
function loadMirrorByAddress() {
  if (!existsSync(MIRROR_MANIFEST)) return new Map()
  const data = JSON.parse(readFileSync(MIRROR_MANIFEST, 'utf8'))
  const byAddr = new Map()
  for (const [label, address] of Object.entries(data?.contracts ?? {})) {
    if (typeof address === 'string') byAddr.set(address.toLowerCase(), label)
  }
  return byAddr
}

/**
 * Parse a Foundry broadcast `run-latest.json` (its already-parsed object) into
 * the deployments `{ contractName, address }`. TWO deploy shapes are handled so
 * the SAME map is correct pre- and post-mirror:
 *
 *   - Legacy per-chain deploy: top-level CREATE txs carry `contractName` +
 *     `contractAddress` directly.
 *   - CREATE3 "mirror" deploy: the contracts are deployed BY CreateX, so they
 *     ride as nameless `additionalContracts[]` on CALL txs — each address is
 *     named by looking it up in `mirrorByAddress` (from mirror-manifest.json);
 *     the CreateX proxy shims (absent from the manifest) are skipped.
 *
 * The LAST entry for a given name wins (the latest run's address). Addresses are
 * lower-cased. Pure + map-injected so a test can feed fixtures directly.
 */
function parseBroadcastData(data, mirrorByAddress = new Map()) {
  const byName = new Map()
  for (const tx of data?.transactions ?? []) {
    // 1) Legacy: a directly-named top-level CREATE.
    if (tx.transactionType === 'CREATE' && tx.contractName && tx.contractAddress) {
      byName.set(tx.contractName, {
        contractName: tx.contractName,
        address: tx.contractAddress.toLowerCase(),
      })
    }
    // 2) Mirror: CreateX-deployed contracts ride in additionalContracts, nameless
    //    — name each via the manifest; the CreateX shims are not in the map.
    for (const extra of tx.additionalContracts ?? []) {
      const addr = extra?.address?.toLowerCase()
      const label = addr && mirrorByAddress.get(addr)
      if (label) byName.set(label, { contractName: label, address: addr })
    }
  }
  return [...byName.values()].sort((a, b) => a.contractName.localeCompare(b.contractName))
}

/**
 * Read a chain's broadcast/run-latest.json from disk and parse it via
 * {@link parseBroadcastData}. Returns [] when the file is absent.
 */
function parseBroadcast(chainId, mirrorByAddress = new Map()) {
  const file = join(BROADCAST_DIR, String(chainId), 'run-latest.json')
  if (!existsSync(file)) return []
  return parseBroadcastData(JSON.parse(readFileSync(file, 'utf8')), mirrorByAddress)
}

/**
 * Strip the trailing solc CBOR metadata from a 0x-prefixed runtime-code hex
 * string IF present. The canonical tail is `…a2 64 'ipfs'|'bzzr0'|'bzzr1' …
 * 64 'solc' 43 <ver> 00 33`, whose last two bytes encode the CBOR length L; the
 * region removed is the final (L + 2) bytes. Returns the input unchanged when no
 * well-formed tail is found (this repo builds metadata-less, so that is the
 * common case). Operates on lower-case hex WITHOUT the 0x prefix.
 */
function stripMetadata(hexNo0x) {
  if (hexNo0x.length < 4) return hexNo0x
  const lenHex = hexNo0x.slice(-4)
  const cborLen = parseInt(lenHex, 16)
  if (!Number.isInteger(cborLen) || cborLen <= 0) return hexNo0x
  const tailBytes = cborLen + 2
  const tailChars = tailBytes * 2
  if (tailChars > hexNo0x.length) return hexNo0x
  const marker = hexNo0x.slice(hexNo0x.length - tailChars, hexNo0x.length - tailChars + 4)
  // The CBOR map header for solc metadata is `a2` (map of 2) + `64` (text key of
  // length 4, e.g. "ipfs"/"solc"). Only strip when the region actually starts
  // with that header — otherwise the trailing 2 bytes were ordinary code.
  if (marker !== 'a264') return hexNo0x
  return hexNo0x.slice(0, hexNo0x.length - tailChars)
}

/**
 * Zero the immutable byte ranges in a runtime-code hex string (no 0x). The
 * Foundry artifact leaves immutables as zeros, but the constructor bakes their
 * values into the ON-CHAIN code; zeroing both sides before hashing is what makes
 * a contract with immutables compare equal when its source is unchanged.
 * `ranges` is an array of [startByte, lengthBytes].
 */
function zeroImmutables(hexNo0x, ranges) {
  if (!ranges.length) return hexNo0x
  const chars = hexNo0x.split('')
  for (const [start, len] of ranges) {
    const from = start * 2
    const to = from + len * 2
    for (let i = from; i < to && i < chars.length; i++) chars[i] = '0'
  }
  return chars.join('')
}

/**
 * Read an out/<Contract>.sol/<Contract>.json artifact and return its normalized
 * runtime-code hash + the immutable ranges. The hash is keccak256 of the
 * 0x-prefixed, metadata-stripped, immutable-zeroed runtime code — IDENTICAL to
 * what lib/bytecodeDiff.ts computes for on-chain code, so the two are comparable.
 */
function artifactBytecode(contractName) {
  const file = join(OUT_DIR, `${contractName}.sol`, `${contractName}.json`)
  if (!existsSync(file)) return null
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const obj = data.deployedBytecode?.object
  if (typeof obj !== 'string' || obj.length === 0) return null
  const raw = obj.startsWith('0x') ? obj.slice(2) : obj
  // Collect immutable ranges as [start, length] byte pairs from the artifact.
  const immRefs = data.deployedBytecode?.immutableReferences ?? {}
  const ranges = []
  for (const refs of Object.values(immRefs)) {
    for (const { start, length } of refs ?? []) ranges.push([start, length])
  }
  ranges.sort((a, b) => a[0] - b[0])
  const normalized = zeroImmutables(stripMetadata(raw.toLowerCase()), ranges)
  const codeHash = keccak256(`0x${normalized}`)
  return { codeHash, immutableRanges: ranges }
}

function main() {
  const checkOnly = process.argv.includes('--check')

  // 0) FAIL-SOFT for a web-only checkout (no `forge build` has run): without the
  //    Foundry artifacts under out/, every deployment would be filtered away and
  //    this script would OVERWRITE the committed-as-generated maps with EMPTY
  //    ones — gutting the /deployments dashboard for anyone who clones the repo
  //    and only builds web/. The committed maps ARE the vendored source of truth
  //    for that flow, so when out/ is absent we keep them verbatim and skip
  //    regeneration (both write and --check modes). Run `forge build` first to
  //    regenerate from fresh artifacts.
  if (!existsSync(OUT_DIR)) {
    console.log(
      'gen-deployments: out/ not found (no forge build) — keeping the committed ' +
        'lib/deployments.ts + lib/currentBytecode.ts as-is. Run `forge build` at the ' +
        'repo root to regenerate.',
    )
    return
  }

  // 1) Every chain dir present under broadcast/, minus purely-local Anvil ids.
  const chainIds = readdirSync(BROADCAST_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => Number(d.name))
    .filter((id) => !LOCAL_CHAIN_IDS.has(id))
    .sort((a, b) => a - b)

  // The canonical CREATE3 mirror address->label map (empty if the manifest is
  //    absent) — names the nameless additionalContracts of a mirror deploy.
  const mirrorByAddress = loadMirrorByAddress()

  // 2) Per chain: its display meta + the deployments (legacy CREATEs and/or
  //    CREATE3 mirror contracts). Only PRODUCT contracts (whose RESOLVED artifact
  //    has a build hash) are kept, so mocks/shims from a run never leak into the
  //    view.
  const chains = []
  const contractNames = new Set()
  for (const chainId of chainIds) {
    const deployments = parseBroadcast(chainId, mirrorByAddress).filter((d) => {
      const artifact = resolveArtifact(d.contractName)
      return existsSync(join(OUT_DIR, `${artifact}.sol`, `${artifact}.json`))
    })
    if (deployments.length === 0) continue
    for (const d of deployments) contractNames.add(d.contractName)
    chains.push({ chainId, ...chainMeta(chainId), deployments })
  }

  // 3) Per deployment name: the normalized current-build code hash of its
  //    RESOLVED artifact (a `.proxy` -> ERC1967Proxy, a `.impl` -> its contract).
  //    Cache by artifact so the shared ERC1967Proxy code is read + hashed once.
  const bytecode = {}
  const byArtifact = new Map()
  for (const name of [...contractNames].sort()) {
    const artifact = resolveArtifact(name)
    if (!byArtifact.has(artifact)) byArtifact.set(artifact, artifactBytecode(artifact))
    const bc = byArtifact.get(artifact)
    if (bc) bytecode[name] = bc
  }

  const banner =
    '// AUTO-GENERATED by scripts/gen-deployments.mjs — DO NOT EDIT BY HAND.\n' +
    '// Regenerate with `node scripts/gen-deployments.mjs` (runs on prebuild).\n' +
    '// Source: broadcast/DeployAll.s.sol/<chainId>/run-latest.json + out/<C>.sol/<C>.json.\n'

  const deploymentsTs =
    banner +
    '\n' +
    '/** Display + deep-link metadata and the CREATE deployments for one chain. */\n' +
    'export interface ChainDeployments {\n' +
    '  /** EIP-155 chain id. */\n' +
    '  readonly chainId: number\n' +
    '  /** Human chain name (from the canonical viem chain object, or Arc inline). */\n' +
    '  readonly name: string\n' +
    "  /** Block-explorer base url (no trailing slash), or undefined when none is known\n" +
    '   *  — the UI then renders the address as plain text, never an invented link. */\n' +
    '  readonly explorer?: string\n' +
    '  /** A public RPC fallback for this chain (overridden by NEXT_PUBLIC_RPC_URL_<id>). */\n' +
    '  readonly rpc?: string\n' +
    '  /** The contracts this chain deployed: { contractName, address } per CREATE tx. */\n' +
    '  readonly deployments: ReadonlyArray<{ readonly contractName: string; readonly address: string }>\n' +
    '}\n\n' +
    '/** Every chain present in broadcast/, with its product-contract deployments. */\n' +
    `export const DEPLOYMENTS: ReadonlyArray<ChainDeployments> = ${JSON.stringify(chains, null, 2)} as const\n`

  const bytecodeTs =
    banner +
    '\n' +
    '/** The normalized current-build runtime-code fingerprint for one contract. */\n' +
    'export interface ContractBytecode {\n' +
    '  /** keccak256 of the metadata-stripped, immutable-zeroed runtime code. */\n' +
    '  readonly codeHash: `0x${string}`\n' +
    '  /** Immutable byte ranges [startByte, lengthBytes] to zero before comparing\n' +
    "   *  on-chain code (the constructor bakes these in; the artifact leaves zeros). */\n" +
    '  readonly immutableRanges: ReadonlyArray<readonly [number, number]>\n' +
    '}\n\n' +
    '/** contractName -> its current-build fingerprint. The dashboard compares the\n' +
    " *  on-chain hash (computed the SAME way) against these. */\n" +
    `export const CURRENT_BYTECODE: Readonly<Record<string, ContractBytecode>> = ${JSON.stringify(
      bytecode,
      null,
      2,
    )} as const\n`

  const deploymentsPath = join(WEB_ROOT, 'lib', 'deployments.ts')
  const bytecodePath = join(WEB_ROOT, 'lib', 'currentBytecode.ts')

  if (checkOnly) {
    const stale =
      (!existsSync(deploymentsPath) || readFileSync(deploymentsPath, 'utf8') !== deploymentsTs) ||
      (!existsSync(bytecodePath) || readFileSync(bytecodePath, 'utf8') !== bytecodeTs)
    if (stale) {
      console.error('lib/deployments.ts or lib/currentBytecode.ts is stale — run gen-deployments.mjs')
      process.exit(1)
    }
    console.log('deployment maps up to date.')
    return
  }

  writeFileSync(deploymentsPath, deploymentsTs)
  writeFileSync(bytecodePath, bytecodeTs)
  console.log(
    `gen-deployments: ${chains.length} chains, ${Object.keys(bytecode).length} contracts ` +
      `-> lib/deployments.ts + lib/currentBytecode.ts`,
  )
}

// Helpers are exported so the vitest suite can exercise the real parse + strip
// logic against fixtures (the generated maps it produces are what the dashboard
// reads). `main()` runs only when this file is invoked directly, never on import.
export {
  parseBroadcast,
  parseBroadcastData,
  stripMetadata,
  zeroImmutables,
  chainMeta,
  resolveArtifact,
  loadMirrorByAddress,
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
