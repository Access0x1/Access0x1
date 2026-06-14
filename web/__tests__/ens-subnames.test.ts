/**
 * @file ens-subnames.test.ts — the Namestone gasless-subname WRITE client.
 *
 * Pins the two halves of the fail-soft contract:
 *   - CONFIGURED (key + parent set): issueSubname / issueMerchantSubname POST to
 *     Namestone with the env parent as `domain`, the label as `name`, the owner,
 *     and the text records — and return the composed `<label>.<parent>` name.
 *   - UNCONFIGURED (key OR parent missing): EVERY path is a NO-OP returning
 *     `not_configured`, makes NO network call, and invents NO name/parent.
 *
 * `fetch` is mocked so the suite is fully offline. The parent is ALWAYS supplied
 * via env (a generic `yourbrand.eth`) — never a real name, never a literal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensSubnameParent,
  isSubnameIssuanceConfigured,
  issueMerchantSubname,
  issueSubname,
  SUBNAME_TEXT_KEYS,
} from '../lib/ens-subnames'

const OWNER = '0x' + '1'.repeat(40)
// Generic parent — "your own ENS name". NEVER a real owner-company name.
const PARENT = 'yourbrand.eth'

const fetchMock = vi.fn()

function configure(): void {
  process.env.NAMESTONE_API_KEY = 'test-key'
  process.env.ENS_SUBNAME_PARENT = PARENT
}
function unconfigure(): void {
  delete process.env.NAMESTONE_API_KEY
  delete process.env.ENS_SUBNAME_PARENT
}

/** A 200 OK Namestone response. */
function okResponse(): Response {
  return { ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  unconfigure()
  delete process.env.NAMESTONE_BASE_URL
})
afterEach(() => {
  vi.unstubAllGlobals()
  unconfigure()
})

describe('config helpers', () => {
  it('isSubnameIssuanceConfigured is false until BOTH key and parent are set', () => {
    expect(isSubnameIssuanceConfigured()).toBe(false)
    process.env.NAMESTONE_API_KEY = 'k'
    expect(isSubnameIssuanceConfigured()).toBe(false) // parent still missing
    process.env.ENS_SUBNAME_PARENT = PARENT
    expect(isSubnameIssuanceConfigured()).toBe(true)
  })

  it('ensSubnameParent reads ONLY from env (empty when unset)', () => {
    expect(ensSubnameParent()).toBe('')
    process.env.ENS_SUBNAME_PARENT = PARENT
    expect(ensSubnameParent()).toBe(PARENT)
  })
})

describe('issueSubname — unconfigured NO-OP (fail-soft)', () => {
  it('returns not_configured and makes NO network call when key+parent unset', async () => {
    const res = await issueSubname({ label: 'merchant-1', owner: OWNER })
    expect(res).toEqual({ ok: false, code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still NO-OPs when only the API key is set (parent missing)', async () => {
    process.env.NAMESTONE_API_KEY = 'k'
    const res = await issueSubname({ label: 'merchant-1', owner: OWNER })
    expect(res).toEqual({ ok: false, code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never invents a name in the not_configured result', async () => {
    const res = await issueSubname({ label: 'merchant-1', owner: OWNER })
    expect(res).not.toHaveProperty('name')
  })
})

describe('issueSubname — configured happy path', () => {
  it('POSTs to Namestone with the env parent as domain + returns <label>.<parent>', async () => {
    configure()
    fetchMock.mockResolvedValue(okResponse())

    const res = await issueSubname({
      label: 'merchant-42',
      owner: OWNER,
      texts: [{ key: 'com.access0x1.merchantId', value: '42' }],
    })

    expect(res).toEqual({
      ok: true,
      name: `merchant-42.${PARENT}`,
      label: 'merchant-42',
      parent: PARENT,
      owner: OWNER,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/set-name')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('test-key')
    const sent = JSON.parse(init.body)
    expect(sent).toMatchObject({
      domain: PARENT, // the env parent, never a literal
      name: 'merchant-42',
      address: OWNER,
      text_records: { 'com.access0x1.merchantId': '42' },
    })
  })

  it('rejects a bad label / owner with bad_input (never issues against a guess)', async () => {
    configure()
    expect((await issueSubname({ label: 'has spaces', owner: OWNER })).ok).toBe(false)
    expect((await issueSubname({ label: 'ok', owner: 'not-an-address' })).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a non-2xx Namestone response to namestone_error (fail-soft)', async () => {
    configure()
    fetchMock.mockResolvedValue({ ok: false, status: 422 } as unknown as Response)
    const res = await issueSubname({ label: 'merchant-7', owner: OWNER })
    expect(res).toEqual({ ok: false, code: 'namestone_error', detail: 'status_422' })
  })

  it('never throws on a network failure — returns namestone_error', async () => {
    configure()
    fetchMock.mockRejectedValue(new TypeError('network down'))
    await expect(issueSubname({ label: 'merchant-7', owner: OWNER })).resolves.toMatchObject({
      ok: false,
      code: 'namestone_error',
    })
  })
})

describe('issueMerchantSubname — onboarding hook', () => {
  it('NO-OPs not_configured when the seam is off', async () => {
    const res = await issueMerchantSubname({ id: 42, owner: OWNER })
    expect(res).toEqual({ ok: false, code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('issues merchant-<id> with USD-pricing + settlement config text records', async () => {
    configure()
    fetchMock.mockResolvedValue(okResponse())

    const res = await issueMerchantSubname({
      id: 42,
      owner: OWNER,
      router: '0x' + '2'.repeat(40),
      chainId: 84532,
    })

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.name).toBe(`merchant-42.${PARENT}`)

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent.name).toBe('merchant-42')
    expect(sent.text_records[SUBNAME_TEXT_KEYS.merchantId]).toBe('42')
    expect(sent.text_records[SUBNAME_TEXT_KEYS.pricingCurrency]).toBe('USD')
    expect(sent.text_records[SUBNAME_TEXT_KEYS.router]).toBe('0x' + '2'.repeat(40))
    expect(sent.text_records[SUBNAME_TEXT_KEYS.chainId]).toBe('84532')
  })

  it('accepts a bigint merchant id', async () => {
    configure()
    fetchMock.mockResolvedValue(okResponse())
    const res = await issueMerchantSubname({ id: 7n, owner: OWNER })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.label).toBe('merchant-7')
  })
})
