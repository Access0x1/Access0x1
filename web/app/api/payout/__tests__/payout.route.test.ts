/**
 * payout.route.test.ts — the private-payout route's money-path guards.
 *
 * This route moves the ENV-configured payout account's private funds to a
 * BODY-CONTROLLED `destination`. It had no test file at all. The handler is
 * dependency-injected, so the guards that matter can be exercised directly:
 *
 *   - the drain guard (a verified caller who is not the payout owner → 403),
 *   - fail-closed on an unverified caller,
 *   - register-BEFORE-shield ordering,
 *   - the asymmetry keystone (deposit must exceed the withdraw),
 *   - and dormant-vs-faulty: an unconfigured seam is a 503, never a 500.
 *
 * Every failure asserted here is one where NO funds moved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handlePayout, type PayoutDeps } from '../route.js'
import { UnlinkNotConfiguredError, UnlinkSdkUnavailableError } from '@/lib/unlink/loadSdk'
import { ShieldFailedError, WithdrawFailedError } from '@/lib/unlink/privateWithdraw'
import { TenantAuthError } from '@/lib/branding/tenant'

const OWNER = 'dynamic-sub-owner'
const DEST = '0x1111111111111111111111111111111111111111'

/** A valid body: the deposit is deliberately larger than the withdraw. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { amountUsd: 10, depositAmountUsd: 25, destination: DEST, ...over }
}

function req(b: unknown = body()): Request {
  return new Request('http://x/api/payout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof b === 'string' ? b : JSON.stringify(b),
  })
}

/** Deps that would succeed, so any non-200 below is caused by the case under test. */
function okDeps(over: Partial<PayoutDeps> = {}): PayoutDeps {
  return {
    resolveVerifiedUserId: vi.fn(async () => ({ userId: OWNER, verified: true })),
    ensureRegistered: vi.fn(async () => undefined),
    shieldAndWithdraw: vi.fn(async () => ({ depositTx: '0xdep', withdrawTx: '0xwit' })),
    ...over,
  } as PayoutDeps
}

beforeEach(() => {
  process.env.UNLINK_PAYOUT_USER_ID = OWNER
})
afterEach(() => {
  delete process.env.UNLINK_PAYOUT_USER_ID
  vi.clearAllMocks()
})

describe('POST /api/payout — authorization', () => {
  it('403s a verified caller who is NOT the payout owner (the drain guard)', async () => {
    // On a hosted checkout every signed-in buyer is verified. Authentication alone
    // would let any of them redirect the merchant's payout to their own address.
    const deps = okDeps({
      resolveVerifiedUserId: vi.fn(async () => ({ userId: 'some-other-buyer', verified: true })),
    })
    const res = await handlePayout(req(), deps)
    expect(res.status).toBe(403)
    expect(deps.shieldAndWithdraw).not.toHaveBeenCalled()
  })

  it('401s a caller the token could not cryptographically verify (fail-closed)', async () => {
    const deps = okDeps({
      resolveVerifiedUserId: vi.fn(async () => ({ userId: OWNER, verified: false })),
    })
    const res = await handlePayout(req(), deps)
    expect(res.status).toBe(401)
    expect(deps.shieldAndWithdraw).not.toHaveBeenCalled()
  })

  it('401s on a TenantAuthError without leaking anything else', async () => {
    const deps = okDeps({
      resolveVerifiedUserId: vi.fn(async () => {
        throw new TenantAuthError('bad token')
      }),
    })
    expect((await handlePayout(req(), deps)).status).toBe(401)
  })
})

describe('POST /api/payout — validation (nothing moves)', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['a zero amount', { amountUsd: 0 }],
    ['a negative amount', { amountUsd: -5 }],
    ['a NaN amount', { amountUsd: Number.NaN }],
    ['a non-numeric amount', { amountUsd: '10' }],
    ['a zero deposit', { depositAmountUsd: 0 }],
    ['a non-address destination', { destination: 'not-an-address' }],
    // The asymmetry keystone: shielding no more than you withdraw defeats the point.
    ['a deposit equal to the withdraw', { amountUsd: 10, depositAmountUsd: 10 }],
    ['a deposit smaller than the withdraw', { amountUsd: 10, depositAmountUsd: 9 }],
  ]

  for (const [label, over] of cases) {
    it(`400s on ${label}`, async () => {
      const deps = okDeps()
      const res = await handlePayout(req(body(over)), deps)
      expect(res.status).toBe(400)
      expect(deps.shieldAndWithdraw).not.toHaveBeenCalled()
    })
  }

  it('400s on a malformed JSON body rather than throwing', async () => {
    expect((await handlePayout(req('{not json'), okDeps())).status).toBe(400)
  })
})

describe('POST /api/payout — ordering and failure mapping', () => {
  it('registers BEFORE shielding, never after', async () => {
    const order: string[] = []
    const deps = okDeps({
      ensureRegistered: vi.fn(async () => {
        order.push('register')
      }),
      shieldAndWithdraw: vi.fn(async () => {
        order.push('shield')
        return { depositTx: '0xdep', withdrawTx: '0xwit' }
      }),
    })
    const res = await handlePayout(req(), deps)
    expect(res.status).toBe(200)
    expect(order).toEqual(['register', 'shield'])
  })

  it('503s when the seam is unconfigured — dormant is not faulty', async () => {
    const deps = okDeps({
      ensureRegistered: vi.fn(async () => {
        throw new UnlinkNotConfiguredError('UNLINK_API_KEY')
      }),
    })
    const res = await handlePayout(req(), deps)
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('not_configured')
  })

  it('503s when the SDK is absent, and never names a server secret in the body', async () => {
    const deps = okDeps({
      ensureRegistered: vi.fn(async () => {
        throw new UnlinkSdkUnavailableError()
      }),
    })
    const res = await handlePayout(req(), deps)
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).not.toMatch(/UNLINK_[A-Z_]*(KEY|PRIVATE)/)
  })

  it('502 shield_failed: nothing shielded, so the caller may safely retry', async () => {
    const deps = okDeps({
      shieldAndWithdraw: vi.fn(async () => {
        throw new ShieldFailedError('rpc down')
      }),
    })
    const res = await handlePayout(req(), deps)
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('shield_failed')
  })

  it('502 withdraw_failed is flagged RECOVERABLE — the shield landed, funds exist', async () => {
    // This distinction is the whole point of splitting the two errors: after a
    // withdraw failure the money is in the private balance, not lost.
    const deps = okDeps({
      shieldAndWithdraw: vi.fn(async () => {
        throw new WithdrawFailedError('relay timeout')
      }),
    })
    const res = await handlePayout(req(), deps)
    const parsed = await res.json()
    expect(res.status).toBe(502)
    expect(parsed.code).toBe('withdraw_failed')
    expect(parsed.recoverable).toBe(true)
  })

  it('200 returns both tx hashes on success', async () => {
    const res = await handlePayout(req(), okDeps())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ depositTx: '0xdep', withdrawTx: '0xwit' })
  })

  it('leaves the pre-booth path open when no payout owner is configured', async () => {
    // With UNLINK_PAYOUT_USER_ID unset there is no owner to compare against, so the
    // 403 must NOT fire — the request proceeds and the seam reports itself dormant.
    delete process.env.UNLINK_PAYOUT_USER_ID
    const deps = okDeps({
      resolveVerifiedUserId: vi.fn(async () => ({ userId: 'anyone', verified: true })),
      ensureRegistered: vi.fn(async () => {
        throw new UnlinkNotConfiguredError('UNLINK_API_KEY')
      }),
    })
    expect((await handlePayout(req(), deps)).status).toBe(503)
  })
})
