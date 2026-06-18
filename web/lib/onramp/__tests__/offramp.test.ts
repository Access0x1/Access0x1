/**
 * @file offramp.test.ts — the provider-agnostic fiat OFF-ramp ("cash out") builder.
 *
 * Pins: with no env it fails soft (`not_configured`, NEVER a guessed sell URL);
 * configured, it builds a hosted SELL URL for whichever provider env selects
 * (MoonPay / Transak / Coinbase), encoding only PUBLIC params — never a secret; a
 * missing/malformed SOURCE address is rejected (`invalid_input`); and the two-layer
 * partner-fee % rides through exactly as on the on-ramp.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildOfframpSession, KNOWN_OFFRAMP_PROVIDERS } from '../offramp'
import { RAMP_DEFAULT_PARTNER_FEE_PERCENT } from '../config'

const OFFRAMP_ENV = [
  'OFFRAMP_PROVIDER',
  'NEXT_PUBLIC_OFFRAMP_BASE_URL',
  'NEXT_PUBLIC_OFFRAMP_APP_ID',
  'NEXT_PUBLIC_OFFRAMP_ASSET',
  'NEXT_PUBLIC_OFFRAMP_NETWORK',
  'OFFRAMP_SERVER_KEY',
  'NEXT_PUBLIC_RAMP_PARTNER_FEE_PERCENT',
] as const

function clearOfframpEnv(): void {
  for (const k of OFFRAMP_ENV) delete process.env[k]
}

const ADDR = ('0x' + '33'.repeat(20)) as `0x${string}`

beforeEach(clearOfframpEnv)
afterEach(clearOfframpEnv)

describe('unconfigured (fail-soft, no guessed URL)', () => {
  it('returns not_configured with NO env set', () => {
    const r = buildOfframpSession({ address: ADDR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
  })

  it('still not_configured when a provider is set but base/app id are blank', () => {
    process.env.OFFRAMP_PROVIDER = 'moonpay'
    const r = buildOfframpSession({ address: ADDR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
  })

  it('an UNKNOWN provider is treated as unconfigured (no guess)', () => {
    process.env.OFFRAMP_PROVIDER = 'totally-made-up'
    process.env.NEXT_PUBLIC_OFFRAMP_BASE_URL = 'https://sell.example.test'
    process.env.NEXT_PUBLIC_OFFRAMP_APP_ID = 'pub-app-1'
    const r = buildOfframpSession({ address: ADDR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
  })

  it('rejects on-ramp-only providers (e.g. stripe has no sell flow)', () => {
    process.env.OFFRAMP_PROVIDER = 'stripe'
    process.env.NEXT_PUBLIC_OFFRAMP_BASE_URL = 'https://sell.example.test'
    process.env.NEXT_PUBLIC_OFFRAMP_APP_ID = 'pub-app-1'
    const r = buildOfframpSession({ address: ADDR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
  })
})

describe('configured — builds a hosted sell URL per provider', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_OFFRAMP_BASE_URL = 'https://sell.example.test'
    process.env.NEXT_PUBLIC_OFFRAMP_APP_ID = 'pub-app-1'
    process.env.NEXT_PUBLIC_OFFRAMP_NETWORK = 'base'
  })

  it('builds a session for EVERY known off-ramp provider, public params only', () => {
    for (const provider of KNOWN_OFFRAMP_PROVIDERS) {
      process.env.OFFRAMP_PROVIDER = provider
      const r = buildOfframpSession({ address: ADDR, amount: '20', redirectUrl: 'https://app.test/done' })
      expect(r.ok, `provider ${provider} should build`).toBe(true)
      if (r.ok) {
        expect(r.provider).toBe(provider)
        const url = new URL(r.url)
        expect(url.origin + url.pathname).toBe('https://sell.example.test/')
        expect(r.url).toContain(ADDR)
        expect(r.url).toContain('pub-app-1')
        expect(r.url).toContain('20')
        expect(r.url).toContain('base')
      }
    }
  })

  it('a server-only key is NEVER placed in the URL', () => {
    process.env.OFFRAMP_PROVIDER = 'moonpay'
    process.env.OFFRAMP_SERVER_KEY = 'sk_super_secret_value'
    const r = buildOfframpSession({ address: ADDR })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url).not.toContain('sk_super_secret_value')
  })

  it('carries the two-layer partner fee (default + deployment override)', () => {
    process.env.OFFRAMP_PROVIDER = 'transak'
    const dflt = buildOfframpSession({ address: ADDR })
    expect(dflt.ok).toBe(true)
    if (dflt.ok) expect(dflt.partnerFeePercent).toBe(RAMP_DEFAULT_PARTNER_FEE_PERCENT)

    process.env.NEXT_PUBLIC_RAMP_PARTNER_FEE_PERCENT = '1.25'
    const overridden = buildOfframpSession({ address: ADDR })
    expect(overridden.ok).toBe(true)
    if (overridden.ok) expect(overridden.partnerFeePercent).toBe(1.25)
  })
})

describe('invalid input (never a guessed address)', () => {
  beforeEach(() => {
    process.env.OFFRAMP_PROVIDER = 'coinbase'
    process.env.NEXT_PUBLIC_OFFRAMP_BASE_URL = 'https://sell.example.test'
    process.env.NEXT_PUBLIC_OFFRAMP_APP_ID = 'pub-app-1'
  })

  it('rejects a malformed source address', () => {
    const r = buildOfframpSession({ address: '0xnope' as `0x${string}` })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_input')
  })

  it('reports not_configured when the configured base URL is malformed', () => {
    process.env.NEXT_PUBLIC_OFFRAMP_BASE_URL = 'not a url'
    const r = buildOfframpSession({ address: ADDR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
  })
})
