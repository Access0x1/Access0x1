/**
 * @file index.test.ts — the provider-agnostic fiat on-ramp session builder.
 *
 * Pins: with no env the builder fails soft (`not_configured`, NEVER a guessed
 * URL); when configured it builds a hosted-checkout URL for WHICHEVER provider
 * env selects (Coinbase / MoonPay / Stripe / Circle / one-tap), encoding only
 * PUBLIC params (app id, address, asset, amount, redirect) — never a secret; and a
 * missing/malformed destination address is rejected (`invalid_input`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildOnrampSession } from '../index'
import { KNOWN_ONRAMP_PROVIDERS } from '../config'

const ONRAMP_ENV = [
  'ONRAMP_PROVIDER',
  'NEXT_PUBLIC_ONRAMP_BASE_URL',
  'NEXT_PUBLIC_ONRAMP_APP_ID',
  'NEXT_PUBLIC_ONRAMP_ASSET',
  'NEXT_PUBLIC_ONRAMP_NETWORK',
  'ONRAMP_SERVER_KEY',
] as const

function clearOnrampEnv(): void {
  for (const k of ONRAMP_ENV) delete process.env[k]
}

const ADDR = ('0x' + '22'.repeat(20)) as `0x${string}`

beforeEach(clearOnrampEnv)
afterEach(clearOnrampEnv)

describe('unconfigured (fail-soft, no guessed URL)', () => {
  it('returns not_configured with NO env set', () => {
    const r = buildOnrampSession({ address: ADDR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
  })

  it('still not_configured when a provider is set but base/app id are blank', () => {
    process.env.ONRAMP_PROVIDER = 'coinbase'
    const r = buildOnrampSession({ address: ADDR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
  })

  it('an UNKNOWN provider is treated as unconfigured (no guess)', () => {
    process.env.ONRAMP_PROVIDER = 'totally-made-up'
    process.env.NEXT_PUBLIC_ONRAMP_BASE_URL = 'https://example.test/buy'
    process.env.NEXT_PUBLIC_ONRAMP_APP_ID = 'pub-app-1'
    const r = buildOnrampSession({ address: ADDR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
  })
})

describe('configured — builds a hosted URL per provider', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_ONRAMP_BASE_URL = 'https://example.test/buy'
    process.env.NEXT_PUBLIC_ONRAMP_APP_ID = 'pub-app-1'
    process.env.NEXT_PUBLIC_ONRAMP_NETWORK = 'base'
  })

  it('builds a session for EVERY known provider, encoding public params only', () => {
    for (const provider of KNOWN_ONRAMP_PROVIDERS) {
      process.env.ONRAMP_PROVIDER = provider
      const r = buildOnrampSession({ address: ADDR, amount: '20', redirectUrl: 'https://app.test/done' })
      expect(r.ok, `provider ${provider} should build`).toBe(true)
      if (r.ok) {
        expect(r.provider).toBe(provider)
        const url = new URL(r.url)
        expect(url.origin + url.pathname).toBe('https://example.test/buy')
        // The destination address is always present (under the provider's own key).
        expect(r.url).toContain(ADDR)
        // The public app id is present; no secret was set, so none can leak.
        expect(r.url).toContain('pub-app-1')
        // The configured amount + network rode through.
        expect(r.url).toContain('20')
        expect(r.url).toContain('base')
      }
    }
  })

  it('a server-only key is NEVER placed in the URL', () => {
    process.env.ONRAMP_PROVIDER = 'moonpay'
    process.env.ONRAMP_SERVER_KEY = 'sk_super_secret_value'
    const r = buildOnrampSession({ address: ADDR })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url).not.toContain('sk_super_secret_value')
  })

  it('omits the amount param when no amount is passed (provider prompts)', () => {
    process.env.ONRAMP_PROVIDER = 'stripe'
    const r = buildOnrampSession({ address: ADDR })
    expect(r.ok).toBe(true)
    // The Stripe amount key is `amount`; with none passed it must be absent.
    if (r.ok) expect(new URL(r.url).searchParams.has('amount')).toBe(false)
  })

  it('an explicit asset/network override the configured defaults', () => {
    process.env.ONRAMP_PROVIDER = 'circle'
    const r = buildOnrampSession({ address: ADDR, asset: 'EURC', network: 'ethereum' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.url).toContain('EURC')
      expect(r.url).toContain('ethereum')
    }
  })
})

describe('invalid input (never a guessed address)', () => {
  beforeEach(() => {
    process.env.ONRAMP_PROVIDER = 'coinbase'
    process.env.NEXT_PUBLIC_ONRAMP_BASE_URL = 'https://example.test/buy'
    process.env.NEXT_PUBLIC_ONRAMP_APP_ID = 'pub-app-1'
  })

  it('rejects a malformed destination address', () => {
    const r = buildOnrampSession({ address: '0xnope' as `0x${string}` })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_input')
  })

  it('reports not_configured when the configured base URL is malformed', () => {
    process.env.NEXT_PUBLIC_ONRAMP_BASE_URL = 'not a url'
    const r = buildOnrampSession({ address: ADDR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
  })
})
