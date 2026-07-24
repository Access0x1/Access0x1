#!/usr/bin/env node
/**
 * show-contracts.mjs — "where is the actual code?"
 *
 * THE PROBLEM THIS SOLVES: the mirror address everyone shares
 * (`0xe92244e3…`) is an ERC-1967 PROXY. Open it on any explorer and you see the
 * proxy's ~50 lines of delegating stub, not the router. The real code lives at a
 * different address, and until now the only way to find it was to open
 * `script/mirror-manifest.json` and read JSON by hand. Nineteen of the twenty
 * deployed contracts are proxied, so this is the normal case, not an edge case.
 *
 * Prints every contract with BOTH addresses and a direct explorer link to the
 * implementation — the page that actually shows the source.
 *
 * `--verify` goes further and reads the live EIP-1967 implementation slot over
 * RPC, so you can prove what a chain is really running rather than trusting the
 * manifest. That is the difference between a claim and a check.
 *
 * USAGE
 *   node scripts/show-contracts.mjs                  # every contract, default chain
 *   node scripts/show-contracts.mjs --chain 84532    # explorer links for one chain
 *   node scripts/show-contracts.mjs --verify         # read the live impl slot on-chain
 *   node scripts/show-contracts.mjs --json           # machine-readable
 *   node scripts/show-contracts.mjs Router           # filter by name substring
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'script', 'mirror-manifest.json')
const BROADCAST = join(ROOT, 'broadcast', 'DeployAll.s.sol')

/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

/**
 * Chain display names for the chains the mirror is broadcast to. NAMES ONLY —
 * no endpoint is baked in here.
 *
 * An earlier version of this script carried a table of explorer and RPC URLs,
 * which is exactly the hardcoding law #3 forbids: an endpoint in source is a
 * value nobody confirmed, silently going stale. Explorer bases and RPCs now come
 * from the environment, keyed by chain id, so a new chain needs no code:
 *
 *     EXPLORER_<chainId>   explorer base, e.g. EXPLORER_84532=https://sepolia.basescan.org
 *     RPC_URL_<chainId>    JSON-RPC endpoint for --verify
 *
 * Unset means the script prints no link and skips verification for that chain
 * rather than guessing one.
 */
const CHAIN_NAMES = {
  84532: 'Base Sepolia',
  11155111: 'Ethereum Sepolia',
  11155420: 'Optimism Sepolia',
  421614: 'Arbitrum Sepolia',
  43113: 'Avalanche Fuji',
  11142220: 'Celo Sepolia',
  5042002: 'Arc Testnet',
  300: 'zkSync Sepolia',
  46630: 'Robinhood Chain',
  16602: '0G Galileo',
  42431: 'Tempo Moderato',
  560048: 'Ethereum Hoodi',
}

/** Read a chain-keyed env var, e.g. `EXPLORER_84532`. Blank/absent ⇒ null. */
const envForChain = (prefix, chainId) => {
  const v = process.env[`${prefix}_${chainId}`]
  return v && v.trim() ? v.trim().replace(/\/$/, '') : null
}

/** Chain metadata: name from the table, endpoints strictly from env. */
const chainInfo = (chainId) => ({
  name: CHAIN_NAMES[chainId] ?? null,
  explorer: envForChain('EXPLORER', chainId),
  rpc: envForChain('RPC_URL', chainId),
})

const ARGS = process.argv.slice(2)
const has = (f) => ARGS.includes(f)
const val = (f, d) => {
  const i = ARGS.indexOf(f)
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d
}
const FILTER = ARGS.find((a) => !a.startsWith('-') && ARGS[ARGS.indexOf(a) - 1] !== '--chain')
const CHAIN = Number(val('--chain', '84532'))

if (!existsSync(MANIFEST)) {
  console.error('No script/mirror-manifest.json. Run `make mirror-manifest` (needs Foundry).')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

/** Group the flat `Name.proxy` / `Name.impl` keys into one row per contract. */
function rows() {
  const byName = new Map()
  for (const [key, address] of Object.entries(manifest.contracts ?? {})) {
    const m = key.match(/^(.*)\.(proxy|impl)$/)
    const name = m ? m[1] : key
    const kind = m ? m[2] : 'direct'
    const row = byName.get(name) ?? { name }
    row[kind] = address
    byName.set(name, row)
  }
  return [...byName.values()].filter((r) => !FILTER || r.name.toLowerCase().includes(FILTER.toLowerCase()))
}

/** Chains with a committed broadcast record — the only ones we claim are live. */
function deployedChains() {
  if (!existsSync(BROADCAST)) return []
  return readdirSync(BROADCAST)
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .sort((a, b) => a - b)
}

/** Read the live EIP-1967 implementation slot. Returns null when unreachable. */
async function liveImpl(rpc, proxy) {
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getStorageAt',
        params: [proxy, IMPL_SLOT, 'latest'],
      }),
    })
    const json = await res.json()
    const raw = json?.result
    if (!raw || raw.length < 42) return null
    const addr = '0x' + raw.slice(-40)
    return /^0x0{40}$/.test(addr) ? null : addr
  } catch {
    return null
  }
}

const all = rows()
const chain = chainInfo(CHAIN)
const deployed = deployedChains()

if (has('--json')) {
  console.log(JSON.stringify({ chainId: CHAIN, deployedChains: deployed, contracts: all }, null, 2))
  process.exit(0)
}

console.log(`\nAccess0x1 — deployed contracts (${all.length} shown)`)
console.log(`Chain for links: ${CHAIN}${chain.name ? ` (${chain.name})` : ''}`)
if (!chain.explorer) {
  console.log(`No EXPLORER_${CHAIN} set — printing addresses without links (nothing is guessed).`)
}
console.log(
  `Broadcast records exist for ${deployed.length} chains: ${deployed.join(', ')}\n` +
    `Addresses are CREATE3-mirrored — identical on every chain above.\n`,
)
console.log(
  'Nineteen of these are ERC-1967 proxies. The mirror address you normally share is the\n' +
    'PROXY; the source you want to read lives at the IMPLEMENTATION.\n',
)

for (const r of all) {
  console.log(`── ${r.name}`)
  if (r.direct) {
    console.log(`   address ${r.direct}   (not proxied — this address IS the code)`)
    if (chain?.explorer) console.log(`   code    ${chain.explorer}/address/${r.direct}#code`)
  } else {
    console.log(`   proxy   ${r.proxy}   ← what you normally land on`)
    console.log(`   impl    ${r.impl}   ← THE SOURCE`)
    if (chain?.explorer) {
      console.log(`   code    ${chain.explorer}/address/${r.impl}#code`)
      console.log(`   state   ${chain.explorer}/address/${r.proxy}#readProxyContract`)
    }
  }
  console.log('')
}

if (has('--verify')) {
  if (!chain?.rpc) {
    console.error(`--verify needs RPC_URL_${CHAIN} set; none configured (nothing is guessed).`)
    process.exit(1)
  }
  console.log(`Reading the live EIP-1967 slot on ${chain.name} — manifest vs chain:\n`)
  let matched = 0
  let mismatch = 0
  let unreachable = 0
  for (const r of all) {
    if (!r.proxy) continue
    const live = await liveImpl(chain.rpc, r.proxy)
    if (!live) {
      unreachable++
      console.log(`  ?  ${r.name.padEnd(30)} no answer — RPC unreachable, or not deployed here`)
      continue
    }
    const ok = live.toLowerCase() === String(r.impl).toLowerCase()
    ok ? matched++ : mismatch++
    console.log(`  ${ok ? 'OK' : '!!'} ${r.name.padEnd(30)} ${ok ? live : `chain=${live}  manifest=${r.impl}`}`)
  }

  // An unread slot is NOT a passing slot. Reporting "all good" after reaching
  // nothing is the exact overclaim this repo forbids, so the summary states the
  // count actually verified and exits non-zero when nothing could be checked.
  console.log('')
  if (mismatch) {
    console.log(
      `${mismatch} MISMATCH — the chain runs code the manifest does not name. Investigate before claiming anything.`,
    )
    process.exit(1)
  }
  if (!matched) {
    console.log(
      `VERIFIED NOTHING: all ${unreachable} reads failed. This is NOT a pass — it means the RPC\n` +
        `was unreachable (network policy, rate limit, or a dead endpoint). Re-run where the RPC\n` +
        `is reachable before trusting the manifest.`,
    )
    process.exit(2)
  }
  console.log(
    `${matched}/${matched + unreachable} proxies verified on ${chain.name}: each points at the implementation\n` +
      `the manifest names.` +
      (unreachable ? `  ${unreachable} could NOT be read and are unverified — not confirmed good.` : ''),
  )
}

console.log(
  'Tip: on an explorer, the proxy page shows the stub. Use the impl link for source,\n' +
    'or the proxy\'s "Read as Proxy" tab to call the real functions against proxy state.\n',
)
