/**
 * readiness.test.ts — the World ID seam's honest self-report.
 *
 * Two things are pinned here, and both are honesty rules rather than mechanics:
 *
 *  1. THE LABEL. `label` is the exact wording the project may use in prose.
 *     Anything short of fully wired reports "built, env-gated" — never "live"
 *     (law #4: a label is never upgraded without proof).
 *  2. NO SECRET, EVER. The report names the env VARIABLES that are blank and
 *     reports presence as a boolean. A credential value must never appear in it,
 *     no matter how the env is filled.
 *
 * The durability dimension gets its own block: a nullifier store that loses
 * claims on restart cannot deliver one-human-per-action, so it keeps `ready`
 * false and is reported as an explicit named mode rather than left implicit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ENV_KEYS = [
  'NEXT_PUBLIC_WORLD_APP_ID',
  'WORLD_RP_ID',
  'WORLD_SIGNING_KEY',
  'WORLD_ACTION',
  'WORLD_OPERATOR_ACTION',
  'WORLD_AGENT_ACTION',
  'WORLD_AGENTKIT_ACTION',
  'NEXT_PUBLIC_WORLD_ENVIRONMENT',
  'NULLIFIER_STORE_URL',
  'DATABASE_URL',
  'VERIFY_REQUIRE_DURABLE_STORE',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** Fill every requirement so the seam reports fully wired. */
function wireEverything(): void {
  process.env.NEXT_PUBLIC_WORLD_APP_ID = 'app_staging_example'
  process.env.WORLD_RP_ID = 'rp_staging_example'
  process.env.WORLD_SIGNING_KEY = '0xkeymaterial'
  process.env.NULLIFIER_STORE_URL = 'postgres://user:pw@localhost:5432/db'
}

const load = async () => (await import('../readiness.js')).worldReadiness()

describe('worldReadiness — the honest label', () => {
  it('reports "built, env-gated" with nothing wired, and never claims live', async () => {
    const r = await load()
    expect(r.ready).toBe(false)
    expect(r.label).toBe('built, env-gated')
  })

  it('names EVERY blank variable, and nothing else', async () => {
    const r = await load()
    expect(r.missing).toEqual([
      'NEXT_PUBLIC_WORLD_APP_ID',
      'WORLD_RP_ID',
      'WORLD_SIGNING_KEY',
      'NULLIFIER_STORE_URL',
    ])
  })

  // The TOP rung is "configured, unverified", never "live". Every check in this
  // module reads env presence, and env presence is evidence a verify COULD
  // complete — never that one did. Claiming "live" off four non-empty variables
  // is a label upgrade without proof (law #4), so the ceiling stays below it.
  it('reports "configured, unverified" — never "live" — when everything is wired', async () => {
    wireEverything()
    const r = await load()
    expect(r.ready).toBe(true)
    expect(r.label).toBe('configured, unverified')
    expect(r.label).not.toBe('live')
    expect(r.missing).toEqual([])
    expect(r.present).toEqual({
      appId: true,
      rpId: true,
      signingKey: true,
      durableNullifierStore: true,
    })
  })

  it('stays "built, env-gated" when only the durable store is missing', async () => {
    wireEverything()
    delete process.env.NULLIFIER_STORE_URL
    const r = await load()
    expect(r.ready).toBe(false)
    expect(r.label).toBe('built, env-gated')
    expect(r.missing).toEqual(['NULLIFIER_STORE_URL'])
  })

  it('rejects an app id that is not a real `app_` id', async () => {
    wireEverything()
    process.env.NEXT_PUBLIC_WORLD_APP_ID = 'not-an-app-id'
    const r = await load()
    expect(r.present.appId).toBe(false)
    expect(r.ready).toBe(false)
  })
})

describe('worldReadiness — nullifier durability is explicit', () => {
  it('calls the dev fallback what it is: in-memory, claims lost on restart', async () => {
    const r = await load()
    expect(r.nullifierStore).toEqual({
      durable: false,
      required: false,
      mode: 'in-memory-dev',
    })
  })

  it('reports fail-closed when a durable store is DEMANDED but absent', async () => {
    process.env.VERIFY_REQUIRE_DURABLE_STORE = 'true'
    const r = await load()
    expect(r.nullifierStore.mode).toBe('fail-closed')
    expect(r.nullifierStore.required).toBe(true)
    expect(r.nullifierStore.durable).toBe(false)
    expect(r.ready).toBe(false)
  })

  it('reports durable once a connection string is configured', async () => {
    process.env.DATABASE_URL = 'postgres://user:pw@localhost:5432/db'
    const r = await load()
    expect(r.nullifierStore.mode).toBe('durable')
    expect(r.nullifierStore.durable).toBe(true)
  })
})

describe('worldReadiness — environment and the single production switch', () => {
  it('defaults to the staging simulator', async () => {
    const r = await load()
    expect(r.environment).toBe('staging')
    expect(r.verifyBase).toBe('https://staging-developer.worldcoin.org')
  })

  it('names ONE env var as the production switch, and that var flips it', async () => {
    const before = await load()
    expect(before.productionSwitch).toBe('NEXT_PUBLIC_WORLD_ENVIRONMENT')

    process.env[before.productionSwitch] = 'production'
    const after = await load()
    expect(after.environment).toBe('production')
    expect(after.verifyBase).toBe('https://developer.world.org')
  })

  it('treats any other value as staging — production is opt-in only', async () => {
    process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT = 'prod'
    expect((await load()).environment).toBe('staging')
  })
})

describe('worldReadiness — secrets never appear', () => {
  it('omits every credential value from the serialised report', async () => {
    process.env.NEXT_PUBLIC_WORLD_APP_ID = 'app_staging_example'
    process.env.WORLD_RP_ID = 'rp_staging_example'
    process.env.WORLD_SIGNING_KEY = '0xTOPSECRETSIGNINGKEYMATERIAL'
    process.env.NULLIFIER_STORE_URL = 'postgres://user:SUPERSECRETPW@localhost:5432/db'
    const raw = JSON.stringify(await load())
    expect(raw).not.toContain('TOPSECRETSIGNINGKEYMATERIAL')
    expect(raw).not.toContain('SUPERSECRETPW')
    expect(raw).not.toContain('postgres://')
    // The rp id and app id are public identifiers, but the report has no reason
    // to echo them either — presence booleans are the whole contract.
    expect(raw).not.toContain('rp_staging_example')
  })

  it('reports the four distinct action strings (public, not secrets)', async () => {
    process.env.WORLD_ACTION = 'a-buyer'
    process.env.WORLD_OPERATOR_ACTION = 'a-operator'
    process.env.WORLD_AGENT_ACTION = 'a-agent'
    process.env.WORLD_AGENTKIT_ACTION = 'a-agentkit'
    const r = await load()
    expect(r.actions).toEqual({
      buyer: 'a-buyer',
      operator: 'a-operator',
      agent: 'a-agent',
      agentkit: 'a-agentkit',
    })
    // Four DISTINCT nullifier namespaces — a collision would let one proof
    // consume another gate's one-per-human slot.
    expect(new Set(Object.values(r.actions)).size).toBe(4)
  })
})
