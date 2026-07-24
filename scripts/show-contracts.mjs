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
 * Chains the mirror is broadcast to, with a public explorer + RPC. Explorer URLs
 * are the ones already used in web/lib/chains.ts and the README mirror table —
 * not invented here. A chain with no public explorer simply prints no link
 * rather than a guessed URL.
 */
const CHAINS = {
  84532: { name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org', rpc: 'https://sepolia.base.org' },
  11155111: { name: 'Ethereum Sepolia', explorer: 'https://sepolia.etherscan.io', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  11155420: { name: 'Optimism Sepolia', explorer: 'https://sepolia-optimism.etherscan.io', rpc: 'https://sepolia.optimism.io' },
  421614: { name: 'Arbitrum Sepolia', explorer: 'https://sepolia.arbiscan.io', rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
  43113: { name: 'Avalanche Fuji', explorer: 'https://testnet.snowtrace.io', rpc: 'https://api.avax-test.network/ext/bc/C/rpc' },
  11142220: { name: 'Celo Sepolia', explorer: '', rpc: '' },
  5042002: { name: 'Arc Testnet', explorer: '', rpc: 'https://rpc.testnet.arc.network' },
  300: { name: 'zkSync Sepolia', explorer: 'https://sepolia.explorer.zksync.io', rpc: 'https://sepolia.era.zksync.dev' },
  46630: { name: 'Robinhood Chain', explorer: '', rpc: '' },
  16602: { name: '0G Galileo', explorer: '', rpc: '' },
  42431: { name: 'Tempo Moderato', explorer: '', rpc: '' },
  560048: { name: 'Ethereum Hoodi', explorer: '', rpc: '' },
}

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
const chain = CHAINS[CHAIN]
const deployed = deployedChains()

if (has('--json')) {
  console.log(JSON.stringify({ chainId: CHAIN, deployedChains: deployed, contracts: all }, null, 2))
  process.exit(0)
}

console.log(`\nAccess0x1 — deployed contracts (${all.length} shown)`)
console.log(`Chain for links: ${CHAIN} ${chain ? `(${chain.name})` : '(unknown — no links)'}`)
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
    console.error(`--verify needs an RPC for chain ${CHAIN}; none configured here.`)
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
