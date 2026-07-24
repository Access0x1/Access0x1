/**
 * envScan.ts — find every environment variable the code ACTUALLY reads.
 *
 * WHY THIS EXISTS: `integrations.ts` is a hand-written table. A hand-written
 * table drifts — when this scanner was first run it found **14 credential-shaped
 * variables** the registry had never heard of (`WORLD_SIGNING_KEY`,
 * `UNLINK_API_KEY`, `OFFRAMP_SERVER_KEY`, …). Every one of them was a key an
 * operator could be missing with nothing in the doctor to tell them.
 *
 * You cannot DERIVE the registry from code: no scanner can know what a key
 * unlocks or which console issues it. What you CAN do is make the list
 * impossible to leave incomplete — scan the source, and fail the build when a
 * credential is read that nobody declared. The table stays hand-written (it
 * carries meaning); its COVERAGE stops being a matter of memory.
 *
 * Pure + filesystem-only so both the CLI (`npm run env:scan`) and the CI test
 * share one implementation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

/** Directories never worth scanning (vendored, generated, or build output). */
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git'])

/** Source extensions that can contain a `process.env` read. */
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx'])

/**
 * A variable whose NAME says it carries a credential. These are the ones that
 * must never be undeclared: a missing tunable is a wrong default, but a missing
 * credential is a feature that silently cannot work.
 */
const CREDENTIAL_SUFFIX = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_MNEMONIC|_SEED|_PASSPHRASE)$/

/**
 * Framework / platform variables that are set by the runtime, not by an
 * operator, so they have no place in an integration registry.
 */
const RUNTIME_VARS = new Set([
  'NODE_ENV',
  'CI',
  'PORT',
  'HOSTNAME',
  'VERCEL',
  'VERCEL_URL',
  'VERCEL_ENV',
  'npm_package_version',
  'npm_lifecycle_event',
])

/** Matches `process.env.FOO` and `process.env['FOO']` / `process.env["FOO"]`. */
const ENV_READ = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g

/** Is this variable name credential-shaped? */
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_SUFFIX.test(name) && !RUNTIME_VARS.has(name)
}

/** Recursively collect scannable source files under `root`. */
function sourceFiles(root: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(root, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) sourceFiles(full, out)
    else if (EXTENSIONS.has(extname(entry))) out.push(full)
  }
  return out
}

/**
 * Every env var name read anywhere under `roots`, sorted and de-duplicated.
 * Runtime/platform variables are excluded — an operator never sets those.
 */
export function scanEnvUsage(roots: readonly string[]): string[] {
  const found = new Set<string>()
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const m of text.matchAll(ENV_READ)) {
        const name = m[1] ?? m[2]
        if (name && !RUNTIME_VARS.has(name)) found.add(name)
      }
    }
  }
  return [...found].sort()
}

/** The result of comparing real usage against the declared registry. */
export interface CoverageReport {
  /** Every var read in the code (excluding runtime/platform vars). */
  readonly used: string[]
  /** Credential-shaped vars read in code but NOT declared — the CI failure set. */
  readonly undeclaredCredentials: string[]
  /** Non-credential vars not declared — informational, not a failure. */
  readonly undeclaredTunables: string[]
  /** Declared in the registry but read nowhere — a likely stale entry or a typo. */
  readonly declaredButUnused: string[]
}

/**
 * Compare code usage against declared names.
 *
 * `undeclaredCredentials` is the only set that fails CI. Tunables are reported
 * so the drift stays visible without turning every internal flag into registry
 * paperwork.
 */
export function coverageReport(used: readonly string[], declared: readonly string[]): CoverageReport {
  const declaredSet = new Set(declared)
  const usedSet = new Set(used)
  return {
    used: [...used],
    undeclaredCredentials: used.filter((v) => isCredentialName(v) && !declaredSet.has(v)),
    undeclaredTunables: used.filter((v) => !isCredentialName(v) && !declaredSet.has(v)),
    declaredButUnused: declared.filter((v) => !usedSet.has(v)),
  }
}
