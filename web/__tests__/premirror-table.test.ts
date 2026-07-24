/**
 * premirror-table.test.ts — law #3, enforced on the README's address table.
 *
 * "No contract address is claimed unless it's in a committed `broadcast/.../<chainId>/`
 * record." That table was hand-maintained for months and an audit found 24 addresses in it
 * that failed the law: twelve attributed to Ethereum Sepolia that appear in no broadcast
 * record on any chain, and twelve labelled Optimism Sepolia that are Base Sepolia's — with
 * explorer links pointing at the wrong explorer.
 *
 * The generator fixed the data; this fixes the class. Every row it emits is checked back
 * against a record IN THAT CHAIN'S OWN DIRECTORY whose `chain` field agrees, which is the
 * single check that would have caught the wrong-chain attribution.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildAddressTable, premirrorSet } from '../scripts/gen-premirror-table.mjs'

const REPO_ROOT = resolve(__dirname, '..', '..')
const BROADCAST_DIR = join(REPO_ROOT, 'broadcast', 'DeployAll.s.sol')

/** `| Chain Name (id) | \`Contract\` | [\`0xaddr\`](…) |` → `{ chainId, address }`. */
function parseRows(table: string): { chainId: number; address: string }[] {
  const rows: { chainId: number; address: string }[] = []
  for (const line of table.split('\n')) {
    const m = /^\|\s*.+?\((\d+)\)\s*\|.*?(0x[0-9a-f]{40})/i.exec(line)
    if (m) rows.push({ chainId: Number(m[1]), address: m[2].toLowerCase() })
  }
  return rows
}

/** Every address CREATEd in a run file that both lives in, and self-reports, this chain. */
function addressesTrulyOn(chainId: number): Set<string> {
  const dir = join(BROADCAST_DIR, String(chainId))
  const found = new Set<string>()
  if (!existsSync(dir)) return found
  for (const f of readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f))) {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    // The load-bearing guard: a run file can carry a different `chain` than its directory.
    // Trusting the path is exactly how Base Sepolia's set got published as OP Sepolia's.
    if (Number(data.chain) !== chainId) continue
    for (const t of data.transactions ?? []) {
      if (t.contractAddress) found.add(String(t.contractAddress).toLowerCase())
      for (const a of t.additionalContracts ?? []) {
        if (a.address) found.add(String(a.address).toLowerCase())
      }
    }
  }
  return found
}

describe('README pre-mirror address table', () => {
  const rows = parseRows(buildAddressTable())

  it('emits rows at all (a silently empty table would vacuously pass everything below)', () => {
    expect(rows.length).toBeGreaterThan(50)
  })

  it('claims no address that is not in a committed record for THAT chain', () => {
    const orphans = rows.filter(({ chainId, address }) => !addressesTrulyOn(chainId).has(address))
    expect(orphans).toEqual([])
  })

  it('never attributes one chain’s deploy to another', () => {
    // Sharper than the check above: an address may legitimately repeat across chains
    // (same deployer + nonce), so assert per-row that the claimed chain is a real home.
    for (const { chainId, address } of rows) {
      expect(addressesTrulyOn(chainId).has(address), `${address} claimed on ${chainId}`).toBe(true)
    }
  })

  it('rejects a chain with no committed directory rather than inventing one', () => {
    // 296 is Hedera: wired in `chains.ts`, deploy target in the Makefile, never broadcast.
    expect(premirrorSet(296)).toBeNull()
    expect(rows.some((r) => r.chainId === 296)).toBe(false)
  })

  it('marks pre-proxy deploys so a bare contract is not read as an upgradeable proxy', () => {
    const table = buildAddressTable()
    if (table.includes(' * |')) {
      expect(table).toContain('Deployed before the proxy migration')
    }
  })
})
