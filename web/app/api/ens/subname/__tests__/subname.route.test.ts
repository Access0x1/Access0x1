/**
 * @file subname.route.test.ts — the /api/ens/subname WRITE route.
 *
 * Pins: POST routes the onboarding shape (merchantId) to issueMerchantSubname and
 * the generic shape (label + texts) to issueSubname; maps the fail-soft codes to
 * HTTP statuses (not_configured → 503, bad_input → 400, namestone_error → 502);
 * and on success echoes the issued name. The ens-subnames lib is mocked so the
 * suite is offline and never touches Namestone or env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const issueSubname = vi.fn()
const issueMerchantSubname = vi.fn()
vi.mock('@/lib/ens-subnames', () => ({
  issueSubname: (input: unknown) => issueSubname(input),
  issueMerchantSubname: (input: unknown) => issueMerchantSubname(input),
}))

const { POST } = await import('../route.js')

const OWNER = '0x' + '1'.repeat(40)
const PARENT = 'yourbrand.eth' // generic — never a real name

function post(body: unknown): Request {
  return new Request('https://x/api/ens/subname', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  issueSubname.mockReset()
  issueMerchantSubname.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/ens/subname — input + routing', () => {
  it('400 invalid json', async () => {
    const res = await POST(post('{not json'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_json')
  })

  it('routes the onboarding shape (merchantId) to issueMerchantSubname', async () => {
    issueMerchantSubname.mockResolvedValue({
      ok: true,
      name: `merchant-42.${PARENT}`,
      label: 'merchant-42',
      parent: PARENT,
      owner: OWNER,
    })
    const res = await POST(post({ merchantId: '42', owner: OWNER, chainId: 84532 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      name: `merchant-42.${PARENT}`,
      label: 'merchant-42',
      parent: PARENT,
      owner: OWNER,
    })
    expect(issueMerchantSubname).toHaveBeenCalledWith(
      expect.objectContaining({ id: '42', owner: OWNER, chainId: 84532 }),
    )
    expect(issueSubname).not.toHaveBeenCalled()
  })

  it('routes the generic shape (label + texts) to issueSubname', async () => {
    issueSubname.mockResolvedValue({
      ok: true,
      name: `shop.${PARENT}`,
      label: 'shop',
      parent: PARENT,
      owner: OWNER,
    })
    const res = await POST(
      post({ label: 'shop', owner: OWNER, texts: [{ key: 'k', value: 'v' }] }),
    )
    expect(res.status).toBe(200)
    expect(issueSubname).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'shop', owner: OWNER, texts: [{ key: 'k', value: 'v' }] }),
    )
    expect(issueMerchantSubname).not.toHaveBeenCalled()
  })
})

describe('POST /api/ens/subname — fail-soft status mapping', () => {
  it('503 not_configured (seam off) — the unconfigured NO-OP', async () => {
    issueMerchantSubname.mockResolvedValue({ ok: false, code: 'not_configured' })
    const res = await POST(post({ merchantId: '1', owner: OWNER }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('not_configured')
  })

  it('400 bad_input (bad label/owner)', async () => {
    issueSubname.mockResolvedValue({ ok: false, code: 'bad_input' })
    const res = await POST(post({ label: 'bad label', owner: 'nope' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('bad_input')
  })

  it('502 namestone_error (upstream) and surfaces the non-secret detail', async () => {
    issueSubname.mockResolvedValue({ ok: false, code: 'namestone_error', detail: 'status_422' })
    const res = await POST(post({ label: 'shop', owner: OWNER }))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'namestone_error', detail: 'status_422' })
  })
})
