/**
 * @file deps-from-env.test.ts — the env→deps assembler is fail-soft per rail, and the
 * /api/payout-swap route turns the worker into a live, non-blocking feature.
 *
 * Hermetic: no real rail is ever called. With no env, every rail is dormant, so a capable
 * chain resolves to a "not configured" no-op and a non-capable chain to "chain-not-capable" —
 * both `swapped: false`, never a throw, never a 500 (law #5).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { buildPayoutSwapDeps } from '../deps-from-env.js'
import { POST } from '../../../app/api/payout-swap/route.js'

const ENV_KEYS = [
  'UNISWAP_TRADING_API_URL',
  'UNISWAP_TRADING_API_KEY',
  'ZKSYNC_SEPOLIA_RPC_URL',
  'BLINK_RPC_URL',
  'PAYOUT_SWAP_INTERNAL_SECRET',
] as const

const SNAPSHOT: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SNAPSHOT[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SNAPSHOT[k] === undefined) delete process.env[k]
    else process.env[k] = SNAPSHOT[k]
  }
})

const USDC = '0x0000000000000000000000000000000000000001' as const
const TOKEN = '0x0000000000000000000000000000000000000002' as const
const MERCHANT = '0x0000000000000000000000000000000000000003' as const

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/payout-swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const validBody = (chainId: number) => ({
  chainId,
  usdc: USDC,
  payoutToken: TOKEN,
  merchant: MERCHANT,
  amountUsdc: '1000000',
  minAmountOut: '1',
})

describe('buildPayoutSwapDeps — env-gated, fail-soft per rail', () => {
  it('returns no rails when no env is set', () => {
    const deps = buildPayoutSwapDeps()
    expect(deps.uniswapTradingApi).toBeUndefined()
    expect(deps.uniswapClassic).toBeUndefined()
    expect(deps.circleAppKit).toBeUndefined()
  })

  it('enables only the Base rail with just the Trading API URL', () => {
    process.env.UNISWAP_TRADING_API_URL = 'https://trade.example/v1'
    const deps = buildPayoutSwapDeps()
    expect(deps.uniswapTradingApi?.baseUrl).toBe('https://trade.example/v1')
    expect(deps.uniswapClassic).toBeUndefined() // no zkSync RPC ⇒ classic stays dormant
    expect(deps.circleAppKit).toBeUndefined()
  })

  it('enables the zkSync classic rail once an RPC is present, Blink only when its RPC is set', () => {
    process.env.UNISWAP_TRADING_API_URL = 'https://trade.example/v1'
    process.env.ZKSYNC_SEPOLIA_RPC_URL = 'https://zk.example/rpc'
    let deps = buildPayoutSwapDeps()
    expect(deps.uniswapClassic).toBeDefined()
    expect(deps.uniswapClassic?.submitBlink).toBeUndefined() // recovery off without BLINK_RPC_URL

    process.env.BLINK_RPC_URL = 'https://base.blinklabs.xyz/v1/key'
    deps = buildPayoutSwapDeps()
    expect(deps.uniswapClassic?.submitBlink).toBeDefined() // recovery on
  })
})

describe('POST /api/payout-swap — validation + dormant fail-soft', () => {
  it('400s on malformed body / addresses / amounts', async () => {
    expect((await POST(post('not json'))).status).toBe(400)
    expect((await POST(post({ usdc: USDC, payoutToken: TOKEN, merchant: MERCHANT, amountUsdc: '1', minAmountOut: '1' }))).status).toBe(400) // no chainId
    expect((await POST(post({ ...validBody(84532), usdc: 'nope' }))).status).toBe(400)
    expect((await POST(post({ ...validBody(84532), amountUsdc: '1.5' }))).status).toBe(400)
  })

  it('chain with no rail ⇒ 200 swapped:false chain-not-capable', async () => {
    const res = await POST(post(validBody(1))) // mainnet: not in the capability table
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.swapped).toBe(false)
    expect(out.reason).toBe('chain-not-capable')
  })

  it('capable chain but unconfigured ⇒ 200 swapped:false (dormant, never a 500)', async () => {
    const res = await POST(post(validBody(84532))) // Base is capable, but no env ⇒ rail not configured
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.swapped).toBe(false)
    expect(out.reason).toBe('chain-not-capable') // mapped from the "not configured" wiring guard
  })

  it('enforces the internal secret only when configured', async () => {
    process.env.PAYOUT_SWAP_INTERNAL_SECRET = 's3cret'
    expect((await POST(post(validBody(1)))).status).toBe(401) // missing header
    const ok = await POST(post(validBody(1), { 'x-internal-secret': 's3cret' }))
    expect(ok.status).toBe(200)
  })
})
