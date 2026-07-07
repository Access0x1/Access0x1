/**
 * @file analytics.test.ts — the privacy floor of the product-analytics client.
 *
 * `analytics.ts` is the single chokepoint every call site funnels through, and it
 * enforces three guarantees in code (not caller discipline): consent-gated +
 * DNT/GPC-respecting emission, no-PII-ever envelopes, and a strip-don't-trust
 * sanitizer. This suite proves each of those, plus the pseudonymous `actor_hash`,
 * the supported-chain-id narrowing (repo law #4 — no mainnet id ever), and that a
 * throwing sink is isolated from the caller (doctrine law #5 — logging never
 * breaks a money path). It leans on the module's own `__resetAnalytics` hook so
 * every test starts from the safe no-consent / no-sink default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetAnalytics,
  computeActorHash,
  configureAnalytics,
  consoleSink,
  grantConsent,
  isSupportedChainId,
  isTrackingEnabled,
  SCHEMA_VERSION,
  setActor,
  setChainContext,
  setRouteContext,
  track,
  withdrawConsent,
  type AnalyticsPayload,
  type AnalyticsSink,
} from '../lib/analytics'

/** A capturing sink: records every payload it is handed, for assertions. */
function makeCapturingSink(): AnalyticsSink & { readonly received: AnalyticsPayload[] } {
  const received: AnalyticsPayload[] = []
  return {
    id: 'capture',
    received,
    send(payload) {
      received.push(payload)
    },
  }
}

beforeEach(() => {
  __resetAnalytics()
})

afterEach(() => {
  __resetAnalytics()
  vi.unstubAllGlobals()
})

describe('consent gate — track() is a hard no-op without consent', () => {
  it('emits nothing when a sink is configured but consent was never granted', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    // No grantConsent() — the safest default state.
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    expect(sink.received).toHaveLength(0)
    expect(isTrackingEnabled()).toBe(false)
  })

  it('emits once consent is granted AND a sink is configured', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    expect(isTrackingEnabled()).toBe(true)
    track({ name: 'page_view', props: { referrer_class: 'internal', is_embed_host: false } })
    expect(sink.received).toHaveLength(1)
    expect(sink.received[0].event).toBe('page_view')
  })

  it('stops emitting after consent is withdrawn', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    withdrawConsent()
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    // Only the first (pre-withdrawal) event landed.
    expect(sink.received).toHaveLength(1)
    expect(isTrackingEnabled()).toBe(false)
  })
})

describe('sink gate — off by default', () => {
  it('is a no-op with consent granted but no sink (nothing leaves the browser)', () => {
    grantConsent()
    // No configureAnalytics({ sink }) — the default sink is null.
    // track() simply returns; the assertion is that it does not throw.
    expect(() =>
      track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } }),
    ).not.toThrow()
  })

  it('disables emission again when the sink is set back to null', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    configureAnalytics({ sink: null })
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    expect(sink.received).toHaveLength(1)
  })
})

describe('browser opt-out — DNT / GPC override a granted consent', () => {
  it('does not track when Do-Not-Track is "1"', () => {
    vi.stubGlobal('navigator', { doNotTrack: '1' })
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    expect(isTrackingEnabled()).toBe(false)
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    expect(sink.received).toHaveLength(0)
  })

  it('does not track when Global-Privacy-Control is true', () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: true })
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    expect(isTrackingEnabled()).toBe(false)
    expect(sink.received).toHaveLength(0)
  })

  it('tracks when the browser signals neither opt-out', () => {
    vi.stubGlobal('navigator', { doNotTrack: '0', globalPrivacyControl: false })
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    expect(isTrackingEnabled()).toBe(true)
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    expect(sink.received).toHaveLength(1)
  })
})

describe('envelope — assembled by track(), always non-PII', () => {
  it('stamps the schema version, a testnet app_env, and the consent flag', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    track({ name: 'page_view', props: { referrer_class: 'internal', is_embed_host: false } })
    const p = sink.received[0]
    expect(p.schema_version).toBe(SCHEMA_VERSION)
    expect(p.consent).toBe('granted')
    // resolveAppEnv() reports 'local' in the vitest (non-production) runtime.
    expect(['local', 'testnet']).toContain(p.app_env)
    expect(typeof p.ts).toBe('number')
    expect(typeof p.anonymous_id).toBe('string')
    expect(typeof p.session_id).toBe('string')
  })

  it('carries the route template + surface set via setRouteContext', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    setRouteContext('/c/[slug]', 'hosted_checkout')
    track({
      name: 'checkout_view',
      props: { checkout_kind: 'slug', amount_bucket: '10_100', token_symbol: 'USDC', gate: 'none' },
    })
    const p = sink.received[0]
    expect(p.path_template).toBe('/c/[slug]')
    expect(p.surface).toBe('hosted_checkout')
  })
})

describe('sanitizer — strip, do not trust (smuggled keys are dropped)', () => {
  it('drops any key not declared in the event taxonomy', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    track({
      name: 'assistant_query',
      props: {
        query_length_bucket: 'm',
        status: 'answered',
        latency_bucket: '1_3s',
        // Smuggled PII a careless call site might attach — must NOT reach the sink.
        prompt: 'my social security number is ...',
        address: '0xdeadbeef',
        email: 'someone@example.com',
      } as never,
    })
    const props = sink.received[0].props as unknown as Record<string, unknown>
    expect(props).toEqual({
      query_length_bucket: 'm',
      status: 'answered',
      latency_bucket: '1_3s',
    })
    expect(props).not.toHaveProperty('prompt')
    expect(props).not.toHaveProperty('address')
    expect(props).not.toHaveProperty('email')
  })

  it('keeps exactly the declared keys for a pay_success event', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    track({
      name: 'pay_success',
      props: {
        method: 'pay_token',
        token_symbol: 'USDC',
        amount_bucket: '100_1k',
        latency_bucket: '3_10s',
        is_first_payment: true,
      },
    })
    expect(Object.keys(sink.received[0].props).sort()).toEqual(
      ['amount_bucket', 'is_first_payment', 'latency_bucket', 'method', 'token_symbol'].sort(),
    )
  })
})

describe('actor_hash — the only way an address enters analytics', () => {
  it('is deterministic for the same address + salt, and case-insensitive', () => {
    configureAnalytics({ salt: 'fixed-salt' })
    const a = computeActorHash('0xABCDEF0123456789abcdef0123456789ABCDEF01')
    const b = computeActorHash('0xabcdef0123456789abcdef0123456789abcdef01')
    expect(a).toBe(b)
  })

  it('produces a 16-char base64url digest with no padding or unsafe chars', () => {
    configureAnalytics({ salt: 'fixed-salt' })
    const hash = computeActorHash('0x1111111111111111111111111111111111111111')
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(hash).not.toContain('=')
  })

  it('changes when the salt rotates (severs historical linkage)', () => {
    configureAnalytics({ salt: 'salt-A' })
    const withA = computeActorHash('0x2222222222222222222222222222222222222222')
    configureAnalytics({ salt: 'salt-B' })
    const withB = computeActorHash('0x2222222222222222222222222222222222222222')
    expect(withA).not.toBe(withB)
  })

  it('sets actor_hash on the envelope from a raw address, and clears it on null', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink, salt: 'fixed-salt' })
    grantConsent()
    setActor('0x3333333333333333333333333333333333333333')
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    expect(sink.received[0].actor_hash).toBe(
      computeActorHash('0x3333333333333333333333333333333333333333'),
    )
    // The raw address never appears in the payload.
    expect(JSON.stringify(sink.received[0])).not.toContain('0x3333')

    setActor(null)
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    expect(sink.received[1].actor_hash).toBeNull()
  })

  it('treats a blank address as "no actor"', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()
    setActor('   ')
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    expect(sink.received[0].actor_hash).toBeNull()
  })
})

describe('chain context — supported testnet ids only, never mainnet (repo law #4)', () => {
  it('recognizes the supported testnet ids', () => {
    expect(isSupportedChainId(5042002)).toBe(true) // Arc Testnet
    expect(isSupportedChainId(84532)).toBe(true) // Base Sepolia
    expect(isSupportedChainId(300)).toBe(true) // zkSync Sepolia
  })

  it('rejects mainnet + unsupported ids and null', () => {
    expect(isSupportedChainId(1)).toBe(false) // Ethereum mainnet
    expect(isSupportedChainId(8453)).toBe(false) // Base mainnet
    expect(isSupportedChainId(null)).toBe(false)
  })

  it('keeps a supported id on the envelope but coerces an unsupported one to null', () => {
    const sink = makeCapturingSink()
    configureAnalytics({ sink })
    grantConsent()

    setChainContext(84532)
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    expect(sink.received[0].chain_id).toBe(84532)

    setChainContext(1) // mainnet — must not survive
    track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } })
    expect(sink.received[1].chain_id).toBeNull()
  })
})

describe('sink isolation — a failing sink never breaks the caller (law #5)', () => {
  it('swallows a synchronous throw from send()', () => {
    const throwingSink: AnalyticsSink = {
      id: 'throwing',
      send() {
        throw new Error('sink exploded')
      },
    }
    configureAnalytics({ sink: throwingSink })
    grantConsent()
    expect(() =>
      track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } }),
    ).not.toThrow()
  })

  it('swallows an async rejection from send()', async () => {
    const rejectingSink: AnalyticsSink = {
      id: 'rejecting',
      send() {
        return Promise.reject(new Error('async sink failure'))
      },
    }
    configureAnalytics({ sink: rejectingSink })
    grantConsent()
    expect(() =>
      track({ name: 'page_view', props: { referrer_class: 'direct', is_embed_host: false } }),
    ).not.toThrow()
    // Let the swallowed rejection settle; an unhandled rejection would fail the run.
    await Promise.resolve()
  })
})

describe('consoleSink — the safe default sink', () => {
  it('has a stable id and never throws when handed a payload', () => {
    expect(consoleSink.id).toBe('console')
    expect(() =>
      consoleSink.send({
        event: 'page_view',
        schema_version: SCHEMA_VERSION,
        ts: Date.now(),
        anonymous_id: 'anon',
        session_id: 'sess',
        surface: 'marketing',
        app_env: 'testnet',
        path_template: '/',
        chain_id: null,
        actor_hash: null,
        consent: 'granted',
        props: { referrer_class: 'direct', is_embed_host: false },
      }),
    ).not.toThrow()
  })
})
