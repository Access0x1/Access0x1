/**
 * Re-vendor the Access0x1ProvenanceRegistry forge artifact into a typed TS module.
 *
 * The forge build output lives in the repo-root `out/` directory, which is
 * gitignored — so the abi + creation bytecode the web bundle needs are vendored
 * into `lib/artifacts/Access0x1ProvenanceRegistry.ts` (committed). Run this after
 * any change to `src/Access0x1ProvenanceRegistry.sol` + `forge build`:
 *
 *     node lib/artifacts/vendor-provenance-registry.mjs
 *
 * The creation bytecode is PUBLIC (it is on-chain the instant anyone deploys),
 * so shipping it in the browser bundle leaks nothing — it carries no secret.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// lib/artifacts -> web -> Access0x1 (repo root) -> out/...
const artifactPath = resolve(
  here,
  '../../../out/Access0x1ProvenanceRegistry.sol/Access0x1ProvenanceRegistry.json',
)
const outPath = resolve(here, 'Access0x1ProvenanceRegistry.ts')

const forge = JSON.parse(readFileSync(artifactPath, 'utf8'))
const abi = forge.abi
const bytecode = forge.bytecode?.object

if (!Array.isArray(abi) || abi.length === 0) {
  throw new Error(`No ABI found in ${artifactPath}`)
}
if (typeof bytecode !== 'string' || !bytecode.startsWith('0x') || bytecode.length < 4) {
  throw new Error(`No creation bytecode found in ${artifactPath}`)
}

const ts = `/**
 * Access0x1ProvenanceRegistry — VENDORED forge artifact (abi + creation bytecode).
 *
 * GENERATED, do not hand-edit. Re-vendor from the compiled artifact with:
 *   node lib/artifacts/vendor-provenance-registry.mjs
 * (which reads ../../out/Access0x1ProvenanceRegistry.sol/Access0x1ProvenanceRegistry.json,
 * the forge out/ build output — gitignored at the repo root, so the abi + bytecode
 * are vendored HERE to ship in the web bundle).
 *
 * The creation bytecode is PUBLIC (it is on-chain the moment anyone deploys the
 * contract) — it is safe to commit and ship in the browser bundle; it carries no
 * secret. The admin "Deploy" button feeds these two exports straight into viem's
 * walletClient.deployContract({ abi, bytecode }) so the owner deploys the registry
 * from their OWN browser wallet — no keystore, no server, no private key in the app.
 */
import type { Abi, Hex } from 'viem'

/** The contract ABI, as emitted by forge build. */
export const PROVENANCE_REGISTRY_ABI = ${JSON.stringify(abi, null, 2)} as const satisfies Abi

/** The creation (constructor) bytecode — public, safe to ship in the bundle. */
export const PROVENANCE_REGISTRY_BYTECODE: Hex = '${bytecode}'
`

writeFileSync(outPath, ts)
console.log(`Vendored ${abi.length} ABI entries + ${bytecode.length}-char bytecode -> ${outPath}`)
