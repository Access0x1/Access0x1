/**
 * lastPayment.test.ts — Proof of Payment: it proves, or it says it can't.
 *
 * The property that matters: this feature must NEVER report a payment it cannot
 * back with a real transaction hash (law 4). Every "no" carries an honest reason,
 * and no failure path throws at the caller (law 1 — it sits off the money path).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_LOOKBACK_BLOCKS,
  formatUsd8,
  lastPayment,
} from '../lastPayment'

const ROUTER = '0xe92244e3368561faf21648146511DeDE3a475EB5' as const
const BUYER = '0x1111111111111111111111111111111111111111' as const
const USDC = '0x2222222222222222222222222222222222222222' as const
const TX = `0x${'ab'.repeat(32)}` as const

function logEntry(over: Record<string, unknown> = {}) {
  return {
    args: {
      merchantId: 7n,
      buyer: BUYER,
      token: USDC,
      grossAmount: 1_000_000n,
      feeAmount: 10_000n,
      netAmount: 990_000n,
      usdAmount8: 100_000_000n, // $1.00
      orderId: `0x${'cd'.repeat(32)}`,
      srcChainSelector: 0n,
    },
    transactionHash: TX,
    blockNumber: 500n,
    ...over,
  }
}

function client(logs: unknown[], head = 100_000n) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(head),
    getLogs: vi.fn().mockResolvedValue(logs),
  }
}

describe('Proof of Payment — the happy path', () => {
  it('returns the LAST settlement with its provable tx hash', async () => {
    const older = logEntry({ transactionHash: `0x${'11'.repeat(32)}`, blockNumber: 100n })
    const newest = logEntry()
    const res = await lastPayment(client([older, newest]) as never, { router: ROUTER })
    expect(res.found).toBe(true)
    if (!res.found) return
    expect(res.txHash).toBe(TX) // the newest, not the first
    expect(res.blockNumber).toBe(500n)
    expect(res.merchantId).toBe(7n)
    expect(res.netAmount).toBe(990_000n)
    expect(res.buyer).toBe(BUYER)
  })

  it('filters by merchant when asked, and by nobody when not', async () => {
    const c = client([logEntry()])
    await lastPayment(c as never, { router: ROUTER, merchantId: 7n })
    expect(c.getLogs.mock.calls[0][0].args).toEqual({ merchantId: 7n })

    const c2 = client([logEntry()])
    await lastPayment(c2 as never, { router: ROUTER })
    expect(c2.getLogs.mock.calls[0][0].args).toEqual({})
  })

  it('searches a BOUNDED window so a public RPC never hangs up', async () => {
    const c = client([logEntry()], 100_000n)
    await lastPayment(c as never, { router: ROUTER })
    const call = c.getLogs.mock.calls[0][0]
    expect(call.fromBlock).toBe(100_000n - DEFAULT_LOOKBACK_BLOCKS)
    expect(call.toBlock).toBe(100_000n)
  })

  it('clamps fromBlock at 0 on a young chain (no bigint underflow)', async () => {
    const c = client([logEntry()], 10n)
    await lastPayment(c as never, { router: ROUTER })
    expect(c.getLogs.mock.calls[0][0].fromBlock).toBe(0n)
  })
})

describe('Proof of Payment — it never fakes a receipt (law 4)', () => {
  it('unconfigured router ⇒ not_configured, no RPC call at all', async () => {
    const c = client([])
    const res = await lastPayment(c as never, { router: null })
    expect(res).toMatchObject({ found: false, reason: 'not_configured' })
    expect(c.getLogs).not.toHaveBeenCalled()
  })

  it('a malformed router address is treated as unconfigured', async () => {
    const res = await lastPayment(client([]) as never, { router: 'not-an-address' as never })
    expect(res).toMatchObject({ found: false, reason: 'not_configured' })
  })

  it('no logs in the window ⇒ an honest "none", never an invented payment', async () => {
    const res = await lastPayment(client([]) as never, { router: ROUTER })
    expect(res).toMatchObject({ found: false, reason: 'no_payments_in_window' })
    if (!res.found) expect(res.detail).toContain('No payment settled')
  })

  it('a log with NO tx hash is refused — unprovable is not reported as paid', async () => {
    const res = await lastPayment(
      client([logEntry({ transactionHash: null })]) as never,
      { router: ROUTER },
    )
    expect(res).toMatchObject({ found: false, reason: 'lookup_failed' })
  })

  it('an RPC failure degrades softly — it never throws at the caller', async () => {
    const c = {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      getLogs: vi.fn().mockRejectedValue(new Error('rpc exploded')),
    }
    const res = await lastPayment(c as never, { router: ROUTER })
    expect(res).toMatchObject({ found: false, reason: 'lookup_failed' })
    if (!res.found) expect(res.detail).toContain('rpc exploded')
  })

  it('a getBlockNumber failure is also soft', async () => {
    const c = {
      getBlockNumber: vi.fn().mockRejectedValue(new Error('head unavailable')),
      getLogs: vi.fn(),
    }
    const res = await lastPayment(c as never, { router: ROUTER })
    expect(res).toMatchObject({ found: false, reason: 'lookup_failed' })
  })
})

describe('formatUsd8', () => {
  it('renders 8-decimal USD as money', () => {
    expect(formatUsd8(100_000_000n)).toBe('$1.00')
    expect(formatUsd8(2_950_000_000n)).toBe('$29.50')
    expect(formatUsd8(0n)).toBe('$0.00')
    expect(formatUsd8(123_456_700_000n)).toBe('$1,234.56')
  })
})
