/**
 * @file tenant.test.ts — server-side Dynamic-JWT tenant resolution (Part A fix #4).
 *
 * The write routes must NOT trust a client-supplied wallet address as the tenant
 * id. `resolveVerifiedTenant` verifies a Dynamic JWT (via jose + the env JWKS)
 * and derives the tenant from the cryptographically-verified wallet claim, only
 * falling back to the shape-checked body when no issuer is configured (the
 * booth-gated/local-demo state). jose is mocked so these run offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jwtVerify = vi.fn()
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'JWKS'),
  jwtVerify: (...args: unknown[]) => jwtVerify(...args),
}))

import {
  TenantAuthError,
  isJwtVerificationConfigured,
  resolveTenantId,
  resolveVerifiedTenant,
  __resetTenantJwksForTests,
} from '../tenant'

const WALLET = '0x' + 'a'.repeat(40)
const OTHER = '0x' + 'b'.repeat(40)

function reqWith(headers: Record<string, string> = {}): Request {
  return new Request('https://x/api/branding', { method: 'POST', headers })
}

beforeEach(() => {
  jwtVerify.mockReset()
  __resetTenantJwksForTests()
  delete process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID
})
afterEach(() => {
  delete process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID
})

describe('resolveTenantId (legacy shape check)', () => {
  it('accepts a lowercased wallet address', () => {
    expect(resolveTenantId({ tenantId: WALLET.toUpperCase() })).toBe(WALLET)
  })
  it('rejects junk', () => {
    expect(() => resolveTenantId({ tenantId: 'nope' })).toThrow(TenantAuthError)
    expect(() => resolveTenantId({})).toThrow(TenantAuthError)
  })
})

describe('isJwtVerificationConfigured', () => {
  it('false with no env id (booth-gated)', () => {
    expect(isJwtVerificationConfigured()).toBe(false)
  })
  it('true once the public env id is set', () => {
    process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID = 'env-123'
    expect(isJwtVerificationConfigured()).toBe(true)
  })
})

describe('resolveVerifiedTenant — fallback (no issuer configured)', () => {
  it('falls back to the shape-checked body, verified:false, never calls jwtVerify', async () => {
    const out = await resolveVerifiedTenant(reqWith(), { tenantId: WALLET })
    expect(out).toEqual({ tenantId: WALLET, verified: false })
    expect(jwtVerify).not.toHaveBeenCalled()
  })
  it('still rejects a junk body tenant id in fallback', async () => {
    await expect(resolveVerifiedTenant(reqWith(), { tenantId: 'junk' })).rejects.toBeInstanceOf(
      TenantAuthError,
    )
  })
})

describe('resolveVerifiedTenant — verified path (issuer + token)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID = 'env-123'
  })

  it('derives the tenant from the verified wallet claim (verified:true)', async () => {
    // Dynamic claims carry a checksummed (mixed-case) 0x address; we lowercase it.
    jwtVerify.mockResolvedValue({
      payload: { verified_credentials: [{ address: '0x' + 'A'.repeat(40) }] },
    })
    const out = await resolveVerifiedTenant(reqWith({ authorization: 'Bearer good.jwt' }), {})
    expect(out).toEqual({ tenantId: WALLET, verified: true })
    expect(jwtVerify).toHaveBeenCalledWith('good.jwt', 'JWKS', expect.any(Object))
  })

  it('rejects when the body tenantId disagrees with the verified wallet', async () => {
    jwtVerify.mockResolvedValue({
      payload: { verified_credentials: [{ address: WALLET }] },
    })
    await expect(
      resolveVerifiedTenant(reqWith({ authorization: 'Bearer good.jwt' }), { tenantId: OTHER }),
    ).rejects.toBeInstanceOf(TenantAuthError)
  })

  it('accepts a matching body tenantId alongside the verified wallet', async () => {
    jwtVerify.mockResolvedValue({
      payload: { verified_credentials: [{ address: WALLET }] },
    })
    const out = await resolveVerifiedTenant(reqWith({ authorization: 'Bearer good.jwt' }), {
      tenantId: WALLET,
    })
    expect(out.verified).toBe(true)
    expect(out.tenantId).toBe(WALLET)
  })

  it('rejects an invalid/expired token (never falls through to body trust)', async () => {
    jwtVerify.mockRejectedValue(new Error('signature verification failed'))
    await expect(
      resolveVerifiedTenant(reqWith({ authorization: 'Bearer bad.jwt' }), { tenantId: WALLET }),
    ).rejects.toBeInstanceOf(TenantAuthError)
  })

  it('rejects a token whose claims carry no wallet', async () => {
    jwtVerify.mockResolvedValue({ payload: { verified_credentials: [{ email: 'a@b.c' }] } })
    await expect(
      resolveVerifiedTenant(reqWith({ authorization: 'Bearer good.jwt' }), {}),
    ).rejects.toBeInstanceOf(TenantAuthError)
  })

  it('with issuer configured but NO token, falls back to the body (verified:false)', async () => {
    const out = await resolveVerifiedTenant(reqWith(), { tenantId: WALLET })
    expect(out).toEqual({ tenantId: WALLET, verified: false })
    expect(jwtVerify).not.toHaveBeenCalled()
  })
})
