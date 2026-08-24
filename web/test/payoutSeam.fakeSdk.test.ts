/**
 * payoutSeam.fakeSdk.test.ts — the private payout seam, ASSEMBLED and executed.
 *
 * Every other unlink test mocks `@unlink-xyz/sdk` per file and proves one unit.
 * None of them proves the seam works when its parts meet, because the real SDK
 * is absent and `loadUnlinkSdk()` throws before anything runs. This file closes
 * that gap: it drives the real `POST /api/payout` handler with the real
 * `ensureRegistered`, the real `getMerchantClient`, the real `shieldAndWithdraw`,
 * the real amount conversion and the real error mapping — substituting only the
 * in-repo fake shielded set (`UNLINK_FAKE_SDK=true`) for the proprietary package.
 *
 * Auth is the single mock. `resolveVerifiedUserId` verifies a Dynamic JWT against
 * a live JWKS, which is a different dependency from the one under test here; its
 * own outcomes are covered by `payoutRoute.test.ts`. Everything downstream of
 * auth is the production code path, unmodified.
 *
 * HONESTY. Nothing here settles. Every hash is synthetic and marked `0xfa4e…`.
 * A green run proves the seam's LOGIC — ordering, validation, the asymmetry
 * keystone, and both law-#5 error surfaces — and proves nothing about the real
 * SDK or any chain. The rail stays "built, env-gated, dependency-absent".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The only mock: the JWT/JWKS auth resolver. */
const auth = { userId: 'owner-1', verified: true }
vi.mock('../lib/branding/tenant.js', () => ({
  resolveVerifiedUserId: async () => ({ userId: auth.userId, verified: auth.verified }),
  TenantAuthError: class TenantAuthError extends Error {},
}))

const { POST } = await import('../app/api/payout/route.js')
const fake = await import('../lib/unlink/fakeSdk.js')

const DESTINATION = '0x1111111111111111111111111111111111111111' as const

const ENV_KEYS = [
  'UNLINK_FAKE_SDK',
  'UNLINK_API_KEY',
  'UNLINK_PAYOUT_PRIVATE_KEY',
  'UNLINK_PAYOUT_USER_ID',
  'UNLINK_ENVIRONMENT',
  'ARC_TESTNET_USDC',
  'NEXT_PUBLIC_UNLINK_CHAIN_ID',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // The full dormant-to-wired env, minus anything real: no key here is a key.
  process.env.UNLINK_FAKE_SDK = 'true'
  process.env.UNLINK_API_KEY = 'fake-api-key-not-a-credential'
  process.env.UNLINK_PAYOUT_PRIVATE_KEY = `0x${'ab'.repeat(32)}`
  process.env.UNLINK_PAYOUT_USER_ID = 'owner-1'
  process.env.ARC_TESTNET_USDC = '0x2222222222222222222222222222222222222222'
  auth.userId = 'owner-1'
  auth.verified = true
  fake.__resetFakeUnlink()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fake.__resetFakeUnlink()
  vi.unstubAllEnvs()
})

function payout(body: unknown): Promise<Response> {
  return POST(
    new Request('https://x/api/payout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

/** A well-formed request: shield $10, withdraw $4 (asymmetric), fresh EOA. */
function goodBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { amountUsd: 4, depositAmountUsd: 10, destination: DESTINATION, ...over }
}

const kinds = (): string[] => fake.fakeUnlinkTranscript().map((e) => e.kind)

describe('POST /api/payout through the fake shielded set — the happy path', () => {
  it('runs register → deposit → waitForTx → withdraw and returns both hashes', async () => {
    const res = await payout(goodBody())
    expect(res.status).toBe(200)

    const body = (await res.json()) as { depositTx: string; withdrawTx: string }
    expect(body.depositTx).toMatch(/^0xfa4e[0-9a-f]{60}$/)
    expect(body.withdrawTx).toMatch(/^0xfa4e[0-9a-f]{60}$/)
    expect(body.depositTx).not.toBe(body.withdrawTx)

    // The ORDER is the contract: the user is registered before anything is
    // shielded, and the shield settles before it is spent.
    expect(kinds()).toEqual(['register', 'deposit', 'waitForTx', 'withdraw'])
  })

  it('shields MORE than it withdraws — the asymmetry keystone, in base units', async () => {
    await payout(goodBody())
    const transcript = fake.fakeUnlinkTranscript()
    const deposit = transcript.find((e) => e.kind === 'deposit')
    const withdraw = transcript.find((e) => e.kind === 'withdraw')

    // $10.00 and $4.00 in 6-decimal USDC base units.
    expect(deposit?.amount).toBe(10_000_000n)
    expect(withdraw?.amount).toBe(4_000_000n)
    expect(deposit?.amount).toBeGreaterThan(withdraw?.amount ?? 0n)

    // The remainder stays in the shielded balance — that residue IS the
    // anonymity set the asymmetry buys.
    expect(fake.fakeShieldedBalance('owner-1')).toBe(6_000_000n)
  })

  it('shields the CONFIGURED token and withdraws to the requested EOA', async () => {
    await payout(goodBody())
    const transcript = fake.fakeUnlinkTranscript()
    expect(transcript.find((e) => e.kind === 'deposit')?.token).toBe(
      '0x2222222222222222222222222222222222222222',
    )
    expect(transcript.find((e) => e.kind === 'withdraw')?.destination).toBe(DESTINATION)
  })

  it('is idempotent on registration — a second payout does not fail on an existing user', async () => {
    expect((await payout(goodBody())).status).toBe(200)
    // The fake throws "already registered" on the repeat; ensureRegistered
    // swallows exactly that case and the payout proceeds.
    expect((await payout(goodBody())).status).toBe(200)
    expect(kinds().filter((k) => k === 'withdraw')).toHaveLength(2)
  })
})

describe('POST /api/payout through the fake — money-path failures surface, never swallow', () => {
  it('shield_failed → 502 with nothing moved', async () => {
    fake.failNextFakeUnlinkCall('deposit')
    const res = await payout(goodBody())
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ code: 'shield_failed' })

    // Nothing was shielded, so nothing is parked and a retry is safe.
    expect(fake.fakeShieldedBalance('owner-1')).toBe(0n)
    expect(kinds()).toEqual(['register'])
  })

  it('withdraw_failed → 502 recoverable, and the funds are visibly PARKED (law #5)', async () => {
    fake.failNextFakeUnlinkCall('withdraw')
    const res = await payout(goodBody())
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ code: 'withdraw_failed', recoverable: true })

    // The shield landed. The whole deposit is sitting in the private balance —
    // recoverable by re-derivation, which is precisely what `recoverable: true`
    // promises the merchant. A swallowed error would have hidden this.
    expect(fake.fakeShieldedBalance('owner-1')).toBe(10_000_000n)
    expect(kinds()).toEqual(['register', 'deposit', 'waitForTx'])
  })

  it('a retry after withdraw_failed spends the parked balance rather than losing it', async () => {
    fake.failNextFakeUnlinkCall('withdraw')
    expect((await payout(goodBody())).status).toBe(502)
    expect((await payout(goodBody())).status).toBe(200)

    // 10 parked + 10 freshly shielded − 4 withdrawn.
    expect(fake.fakeShieldedBalance('owner-1')).toBe(16_000_000n)
  })
})

describe('POST /api/payout through the fake — the guards hold before any money moves', () => {
  it('rejects a non-asymmetric request without touching the shielded set', async () => {
    const res = await payout(goodBody({ amountUsd: 10, depositAmountUsd: 10 }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'depositAmountUsd must be greater than amountUsd' })
    expect(kinds()).toEqual([])
  })

  it('rejects an invalid destination before registering anything', async () => {
    const res = await payout(goodBody({ destination: 'not-an-address' }))
    expect(res.status).toBe(400)
    expect(kinds()).toEqual([])
  })

  it('rejects an unverified caller — auth precedes every side effect', async () => {
    auth.verified = false
    const res = await payout(goodBody())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unverified_caller' })
    expect(kinds()).toEqual([])
  })

  it('rejects a verified caller who is NOT the payout owner (the anti-drain binding)', async () => {
    auth.userId = 'some-other-signed-in-buyer'
    const res = await payout(goodBody())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect(kinds()).toEqual([])
  })

  it('stays dormant with a clean 503 when the shielded token is unconfigured', async () => {
    delete process.env.ARC_TESTNET_USDC
    const res = await payout(goodBody())
    // The token check lives inside shieldAndWithdraw, after registration and
    // BEFORE any SDK call. A blank token is a dormant seam, not a fault: it
    // answers 503 `not_configured` like every other unwired state, never the
    // 500 `unexpected_error` an operator would read as "my deployment is broken".
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ code: 'not_configured', recoverable: true })
    expect(kinds()).toEqual(['register'])
    expect(fake.fakeShieldedBalance('owner-1')).toBe(0n)
  })

  it('answers 503 not_configured when the API key is absent — dormant, not faulty', async () => {
    delete process.env.UNLINK_API_KEY
    const res = await payout(goodBody())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ code: 'not_configured', recoverable: true })
    expect(kinds()).toEqual([])
  })
})

describe('the degrade path — the fake is opt-in, and refused in production', () => {
  it('without the flag the seam reports the SDK absent and moves nothing', async () => {
    delete process.env.UNLINK_FAKE_SDK
    const res = await payout(goodBody())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ code: 'unlink_sdk_unavailable', recoverable: true })
    expect(kinds()).toEqual([])
  })

  it('the flag is REFUSED in a production build — a fake payout must never report success', async () => {
    const { __resetFakeSdkFlagWarning } = await import('../lib/unlink/fakeSdkFlag.js')
    __resetFakeSdkFlagWarning()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('NODE_ENV', 'production')

    const res = await payout(goodBody())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ code: 'unlink_sdk_unavailable', recoverable: true })
    expect(kinds()).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('an explicit non-"true" value does not enable the fake', async () => {
    process.env.UNLINK_FAKE_SDK = '1'
    const res = await payout(goodBody())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ code: 'unlink_sdk_unavailable', recoverable: true })
  })
})
