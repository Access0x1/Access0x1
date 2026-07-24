/**
 * registry-coverage.test.ts — the registry cannot silently go stale.
 *
 * `integrations.ts` is hand-written because meaning can't be derived: no scanner
 * knows what a key unlocks or which console issues it. But COVERAGE can be
 * enforced, and this is what enforces it.
 *
 * THE LAW: every credential-shaped variable the code reads must be declared.
 * When this check was first written it caught 14 undeclared credentials —
 * `WORLD_SIGNING_KEY`, `UNLINK_API_KEY`, `OFFRAMP_SERVER_KEY`, and more. Each
 * was a key an operator could be missing with nothing in `env:doctor` to say so.
 * That is the exact failure this test exists to prevent recurring.
 *
 * Adding an API is still ONE registry entry — this just guarantees you can't
 * forget it.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { INTEGRATIONS, allKnownVarNames } from '../integrations'
import { coverageReport, isCredentialName, scanEnvUsage } from '../envScan'

const WEB_ROOT = resolve(__dirname, '../../..')
const ROOTS = ['app', 'lib', 'components', 'scripts'].map((d) => resolve(WEB_ROOT, d))

const used = scanEnvUsage(ROOTS)
const report = coverageReport(used, allKnownVarNames())

describe('env scanner', () => {
  it('finds real env reads across the app (sanity — a broken scanner must not pass silently)', () => {
    expect(used.length).toBeGreaterThan(50)
    expect(used).toContain('CLAUDE_API_KEY')
    expect(used).toContain('AGENT_DAILY_USD_CAP')
  })

  it('excludes runtime/platform vars an operator never sets', () => {
    expect(used).not.toContain('NODE_ENV')
    expect(used).not.toContain('CI')
  })

  it('classifies credential-shaped names by suffix', () => {
    expect(isCredentialName('WORLD_SIGNING_KEY')).toBe(true)
    expect(isCredentialName('TELEGRAM_BOT_TOKEN')).toBe(true)
    expect(isCredentialName('WALLET_PASSWORD')).toBe(true)
    expect(isCredentialName('AGENT_DAILY_USD_CAP')).toBe(false)
    expect(isCredentialName('NODE_ENV')).toBe(false)
  })
})

describe('THE LAW: no undeclared credentials', () => {
  it('every credential the code reads is declared in the registry', () => {
    // If this fails, add the variable to INTEGRATIONS in lib/config/integrations.ts.
    // Do NOT add it to an ignore list — an operator who cannot see a missing key
    // cannot supply it, and `env:doctor` would report a green check over a call
    // that will 401.
    expect(
      report.undeclaredCredentials,
      `Undeclared credential env vars (add them to INTEGRATIONS):\n  ${report.undeclaredCredentials.join('\n  ')}`,
    ).toEqual([])
  })

  it('every secret is server-only — no NEXT_PUBLIC_ credential is marked secret', () => {
    // A NEXT_PUBLIC_ var is inlined into the client bundle at build time, so it
    // is public by construction and must never be declared `secret: true`.
    for (const integration of INTEGRATIONS) {
      for (const v of integration.vars) {
        if (v.secret) expect(v.name.startsWith('NEXT_PUBLIC_'), v.name).toBe(false)
      }
    }
  })
})

describe('.env.example stays in sync', () => {
  // The third place a variable can go stale. The registry knows a key exists and
  // the code reads it, but an operator copying .env.example would never see it.
  const examplePath = resolve(WEB_ROOT, '.env.example')
  const exampleText = readFileSync(examplePath, 'utf8')
  const inExample = new Set(
    [...exampleText.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string),
  )

  it('every declared variable appears in .env.example (commented or not)', () => {
    const missing = allKnownVarNames().filter((v) => !inExample.has(v))
    expect(
      missing,
      `Declared in INTEGRATIONS but absent from web/.env.example:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('.env.example never ships a real-looking secret value', () => {
    // A placeholder is fine; a 32+ char high-entropy value next to a *_KEY name
    // is how a key gets committed. Scoped to credential-shaped names only.
    const offenders: string[] = []
    for (const line of exampleText.split('\n')) {
      const m = line.trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
      if (!m) continue
      const [, name, raw] = m
      if (!name || !isCredentialName(name)) continue
      const value = (raw ?? '').trim().replace(/^["']|["']$/g, '')
      if (value.length >= 32 && /^[A-Za-z0-9_\-+/=]+$/.test(value) && !/PASTE|YOUR|EXAMPLE|xxx|\.\.\./i.test(value)) {
        offenders.push(name)
      }
    }
    expect(offenders, `Possible real secret committed in .env.example: ${offenders.join(', ')}`).toEqual([])
  })
})

describe('registry hygiene (reported, not enforced)', () => {
  it('does not declare variables the code never reads', () => {
    // A declared-but-unread var is a typo or a removed feature; either way the
    // doctor would ask an operator for something that does nothing.
    expect(
      report.declaredButUnused,
      `Declared in INTEGRATIONS but read nowhere in code:\n  ${report.declaredButUnused.join('\n  ')}`,
    ).toEqual([])
  })
})
