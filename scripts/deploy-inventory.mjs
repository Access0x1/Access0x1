#!/usr/bin/env node
/**
 * deploy-inventory.mjs — one table answering "what do we deploy, and do we deploy anything twice?"
 *
 * WHY. The repo has 39 first-party contracts, a CREATE3 mirror set, AND legacy per-chain
 * pre-mirror deploys, plus a Vyper directory that is deliberately never deployed. Working out
 * which contracts are live, which are built-but-dormant, and which are dead weight meant reading
 * `DeployAll.s.sol`, every `broadcast/` record and every import graph by hand — so nobody did,
 * and the answer drifted. Two documents claim `NameMath` is "wired into the router" while no
 * production contract imports it at all.
 *
 * This derives the answer instead. Four questions per contract, each from a file on disk:
 *
 *   DEPLOYED?   — does `DeployAll.s.sol` name it, and does a committed broadcast record carry it?
 *   USED?       — does any OTHER contract under `src/` import it?
 *   DUPLICATED? — does a chain carry it at more than one address (pre-mirror AND mirror)?
 *   LANGUAGE    — Solidity, or one of the isolated Vyper twins under `vyper/`?
 *
 * It runs WITHOUT Foundry, on purpose: this is exactly the question you want answered before a
 * deploy, on any machine. `forge coverage` (make coverage) is the separate question of how well
 * the deployed set is TESTED, and that one does need Foundry.
 *
 * Usage:
 *   node scripts/deploy-inventory.mjs            # the table
 *   node scripts/deploy-inventory.mjs --json     # machine-readable
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const VYPER_SRC = join(ROOT, 'vyper', 'src')
const SCRIPT_DIR = join(ROOT, 'script')
const BROADCAST = join(ROOT, 'broadcast')

/**
 * Anvil. A local chain is not a deployment: `make deploy-local` leaves records under
 * `broadcast/…/31337`, and counting them inflated the live-chain totals AND reported the
 * Router as "deployed twice on 31337" — which is just two local runs, the least
 * interesting fact available. Excluded so the duplicate warning only ever means a real
 * chain carrying a real second address.
 */
const LOCAL_CHAIN_IDS = new Set([31337])

/** Every `.sol` under src/, excluding the interface directory. */
function solFiles(dir = SRC) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'interfaces') out.push(...solFiles(p))
    } else if (e.name.endsWith('.sol')) out.push(p)
  }
  return out
}

/** Concrete contract + library declarations in a file (not interfaces). */
function declarationsIn(file) {
  const text = readFileSync(file, 'utf8')
  const out = []
  for (const m of text.matchAll(/^(?:abstract\s+)?(contract|library)\s+([A-Za-z0-9_]+)/gm)) {
    out.push({ name: m[2], kind: m[1] })
  }
  return out
}

/**
 * Names any `script/*.s.sol` passes as a deploy label.
 *
 * ALL of them, not just `DeployAll` — `ChainRegistry` is deployed by its own
 * `DeployChainRegistry` script, and reading only the main one reported it as dead code.
 */
function deployedByScript() {
  const labels = new Set()
  for (const f of readdirSync(SCRIPT_DIR)) {
    if (!f.endsWith('.s.sol')) continue
    const text = readFileSync(join(SCRIPT_DIR, f), 'utf8')
    // Strip comments first: a contract NAMED in a docblock is not a contract deployed.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const m of code.matchAll(/"([A-Za-z0-9_]+)"/g)) labels.add(m[1])
  }
  return labels
}

/**
 * chainId → { contractName → Set(address) } from every committed run file whose own `chain`
 * field agrees with its directory. Collecting ALL addresses per name (not just the newest) is
 * what surfaces a contract deployed twice on one chain.
 */
function onChain() {
  const byChain = new Map()
  if (!existsSync(BROADCAST)) return byChain
  // EVERY script's broadcast tree, not just DeployAll's — a contract deployed by a
  // sidecar script is still deployed.
  for (const scriptDir of readdirSync(BROADCAST, { withFileTypes: true })) {
    if (!scriptDir.isDirectory()) continue
    const base = join(BROADCAST, scriptDir.name)
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue
      const chainId = Number(d.name)
      if (LOCAL_CHAIN_IDS.has(chainId)) continue
      if (!byChain.has(chainId)) byChain.set(chainId, new Map())
      const perName = byChain.get(chainId)
      for (const f of readdirSync(join(base, d.name))) {
        if (!/^run-\d+\.json$/.test(f)) continue
        let data
        try {
          data = JSON.parse(readFileSync(join(base, d.name, f), 'utf8'))
        } catch {
          continue
        }
        if (Number(data.chain) !== chainId) continue
        for (const t of data.transactions ?? []) {
          if (!t.contractName || !t.contractAddress) continue
          if (!perName.has(t.contractName)) perName.set(t.contractName, new Set())
          perName.get(t.contractName).add(String(t.contractAddress).toLowerCase())
        }
      }
    }
  }
  return byChain
}

/** Names imported by some OTHER file under src/ — i.e. actually used in production code. */
function importedNames(files) {
  const used = new Set()
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
      // Only count first-party imports; OZ/forge deps are not our surface.
      if (!m[2].startsWith('.')) continue
      for (const nm of m[1].split(',')) used.add(nm.trim())
    }
  }
  return used
}

function main() {
  const files = solFiles()
  const declared = files.flatMap((f) => declarationsIn(f).map((d) => ({ ...d, file: f })))
  const scriptLabels = deployedByScript()
  const chains = onChain()
  const used = importedNames(files)

  const vyperTwins = existsSync(VYPER_SRC)
    ? readdirSync(VYPER_SRC)
        .filter((f) => f.endsWith('.vy'))
        .map((f) => basename(f, '.vy'))
    : []

  const rows = declared.map(({ name, kind, file }) => {
    const chainsWith = []
    let duplicatedOn = []
    for (const [chainId, perName] of chains) {
      const addrs = perName.get(name)
      if (addrs && addrs.size) {
        chainsWith.push(chainId)
        if (addrs.size > 1) duplicatedOn.push(`${chainId}×${addrs.size}`)
      }
    }
    const inScript = scriptLabels.has(name)
    const isUsed = used.has(name)
    let verdict
    if (chainsWith.length > 0) verdict = 'LIVE'
    else if (inScript) verdict = 'IN DEPLOY SCRIPT, NO RECORD'
    else if (isUsed) verdict = 'internal (used by another contract)'
    else verdict = 'BUILT, NOT DEPLOYED, NOT IMPORTED'

    return {
      name,
      kind,
      file: file.slice(ROOT.length + 1),
      inDeployScript: inScript,
      importedBySrc: isUsed,
      chains: chainsWith.sort((a, b) => a - b),
      duplicatedOn,
      vyperTwin: vyperTwins.includes(name),
      verdict,
    }
  })

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rows, vyperTwins }, null, 2))
    return
  }

  const order = {
    LIVE: 0,
    'IN DEPLOY SCRIPT, NO RECORD': 1,
    'internal (used by another contract)': 2,
    'BUILT, NOT DEPLOYED, NOT IMPORTED': 3,
  }
  rows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.name.localeCompare(b.name))

  let lastVerdict = null
  for (const r of rows) {
    if (r.verdict !== lastVerdict) {
      console.log(`\n── ${r.verdict} ${'─'.repeat(Math.max(0, 46 - r.verdict.length))}`)
      lastVerdict = r.verdict
    }
    const bits = []
    if (r.chains.length) bits.push(`chains: ${r.chains.length}`)
    if (r.duplicatedOn.length) bits.push(`⚠ TWO ADDRESSES ON ${r.duplicatedOn.join(', ')}`)
    if (r.vyperTwin) bits.push('has a Vyper twin (never deployed)')
    console.log(`  ${r.name.padEnd(30)} ${bits.join('  ')}`)
  }

  const dupes = rows.filter((r) => r.duplicatedOn.length)
  const dead = rows.filter((r) => r.verdict === 'BUILT, NOT DEPLOYED, NOT IMPORTED')
  console.log(`\n${rows.length} declarations · ${rows.filter((r) => r.chains.length).length} live`)
  console.log(
    `${dupes.length} carry more than one address on a single chain` +
      (dupes.length ? ` — ${dupes.map((d) => d.name).join(', ')}` : ''),
  )
  console.log(`${dead.length} are built but neither deployed nor imported by any contract.`)
  console.log(
    '\nA second address on one chain is usually a pre-mirror deploy the CREATE3 cutover\n' +
      'superseded, not a bug — but it IS the thing to check before deploying again.\n' +
      'Vyper twins under vyper/ are conformance demonstrators: foundry.toml pins src="src",\n' +
      'so forge never compiles them and no deploy path can reach them.\n',
  )
}

main()
