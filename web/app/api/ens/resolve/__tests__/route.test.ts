/**
 * route.test.ts — the /api/ens/resolve CCIP-Read gateway. Proves the capability
 * probe, the fail-soft null on a malformed/unsupported target, the single-record
 * (key) form, and the full-records form — all off the money path, never a 500.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const isEnsV2ConfiguredMock = vi.fn(() => false)
const isSettlementChainMock = vi.fn((id: number) => id === 84_532)
const resolvePaymentRecordsMock = vi.fn()
const resolveRecordMock = vi.fn()
const paymentResolverAddressMock = vi.fn((_id: number) => null as string | null)

vi.mock('@/lib/chains', () => ({ isSettlementChain: (id: number) => isSettlementChainMock(id) }))
vi.mock('@/lib/ens/ensv2', () => ({
  isEnsV2Configured: () => isEnsV2ConfiguredMock(),
  paymentResolverAddress: (id: number) => paymentResolverAddressMock(id),
  resolvePaymentRecords: (...a: unknown[]) => resolvePaymentRecordsMock(...a),
  resolveRecord: (...a: unknown[]) => resolveRecordMock(...a),
}))

import { GET } from '@/app/api/ens/resolve/route'

function get(qs: string): Request {
  return new Request(`http://localhost/api/ens/resolve${qs}`)
}

afterEach(() => vi.clearAllMocks())

describe('/api/ens/resolve', () => {
  it('is a capability probe with no target', async () => {
    isEnsV2ConfiguredMock.mockReturnValue(true)
    const res = await GET(get(''))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ configured: true })
  })

  it('fails soft to null on an unsupported chain (never 500)', async () => {
    const res = await GET(get('?chainId=1&merchantId=1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ payout: null, texts: {} })
    expect(resolvePaymentRecordsMock).not.toHaveBeenCalled()
  })

  it('serves a single record for the key form', async () => {
    resolveRecordMock.mockResolvedValue('USD')
    const res = await GET(get('?chainId=84532&merchantId=42&key=click.access0x1.pricingCurrency'))
    expect(await res.json()).toEqual({ value: 'USD' })
    expect(resolveRecordMock).toHaveBeenCalledWith(84_532, 42n, 'click.access0x1.pricingCurrency')
  })

  it('serves full live records for a valid target', async () => {
    resolvePaymentRecordsMock.mockResolvedValue({
      payout: '0x00000000000000000000000000000000000000bb',
      coinType: 2_147_568_180,
      texts: { 'click.access0x1.merchantId': '42' },
    })
    const res = await GET(get('?chainId=84532&merchantId=42'))
    const body = await res.json()
    expect(body.payout).toBe('0x00000000000000000000000000000000000000bb')
    expect(body.merchantId).toBe('42')
    expect(body.texts['click.access0x1.merchantId']).toBe('42')
  })

  it('fails soft to null payout when the seat is unknown', async () => {
    resolvePaymentRecordsMock.mockResolvedValue(null)
    const res = await GET(get('?chainId=84532&merchantId=999'))
    expect((await res.json()).payout).toBeNull()
  })
})
