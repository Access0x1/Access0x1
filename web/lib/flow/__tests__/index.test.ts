/**
 * @file index.test.ts — the OPTIONAL "pay in any token → USDC" Flow seam.
 *
 * Pins the TRUTH-critical behaviour (law #4):
 *   - DEFAULT OFF: with no env the option is unconfigured and `prepareFlowSwap`
 *     returns `not_configured` — nothing changes (native/USDC pay as today).
 *   - the public flag + app id alone decide VISIBILITY; the full configured check
 *     also requires a known provider.
 *   - CONFIGURED but no real adapter ⇒ `swap_adapter_unavailable` — the seam is
 *     wired but NEVER claims a token was swapped/settled.
 *   - a missing/malformed address or amount ⇒ `invalid_input` (never guessed).
 *   - CONFIGURED + an injected (fake) adapter ⇒ the swap result is surfaced as-is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  prepareFlowSwap,
  unavailableSwapAdapter,
  SwapAdapterUnavailableError,
  type FlowSwapInput,
  type SwapAdapter,
} from '../index'
import {
  isFlowConfigured,
  isFlowEnabled,
  isFlowPublicConfigured,
  flowSettleAsset,
  KNOWN_FLOW_PROVIDERS,
} from '../config'

const FLOW_ENV = [
  'NEXT_PUBLIC_FLOW_ENABLED',
  'FLOW_PROVIDER',
  'NEXT_PUBLIC_FLOW_APP_ID',
  'NEXT_PUBLIC_FLOW_SETTLE_ASSET',
  'FLOW_SERVER_KEY',
] as const

function clearFlowEnv(): void {
  for (const k of FLOW_ENV) delete process.env[k]
}

const ADDR = ('0x' + '44'.repeat(20)) as `0x${string}`
const TOKEN = ('0x' + '55'.repeat(20)) as `0x${string}`

function input(over: Partial<FlowSwapInput> = {}): FlowSwapInput {
  return {
    chainId: 84532,
    address: ADDR,
    inputToken: { address: TOKEN, amount: '12.5', symbol: 'DAI' },
    ...over,
  }
}

function configure(provider = 'lifi'): void {
  process.env.NEXT_PUBLIC_FLOW_ENABLED = 'true'
  process.env.FLOW_PROVIDER = provider
  process.env.NEXT_PUBLIC_FLOW_APP_ID = 'flow-app-1'
}

beforeEach(clearFlowEnv)
afterEach(clearFlowEnv)

describe('config gating — default OFF', () => {
  it('no env ⇒ disabled, unconfigured, hidden', () => {
    expect(isFlowEnabled()).toBe(false)
    expect(isFlowConfigured()).toBe(false)
    expect(isFlowPublicConfigured()).toBe(false)
  })

  it('the flag alone is NOT enough — needs a public app id', () => {
    process.env.NEXT_PUBLIC_FLOW_ENABLED = 'true'
    expect(isFlowEnabled()).toBe(true)
    expect(isFlowPublicConfigured()).toBe(false)
  })

  it('flag + app id ⇒ visible; full configured ALSO needs a known provider', () => {
    process.env.NEXT_PUBLIC_FLOW_ENABLED = 'true'
    process.env.NEXT_PUBLIC_FLOW_APP_ID = 'flow-app-1'
    expect(isFlowPublicConfigured()).toBe(true)
    // Visible, but the server-side builder is NOT configured without a provider.
    expect(isFlowConfigured()).toBe(false)
    process.env.FLOW_PROVIDER = 'uniswap'
    expect(isFlowConfigured()).toBe(true)
  })

  it('an UNKNOWN provider is treated as unconfigured (no guess)', () => {
    process.env.NEXT_PUBLIC_FLOW_ENABLED = 'true'
    process.env.NEXT_PUBLIC_FLOW_APP_ID = 'flow-app-1'
    process.env.FLOW_PROVIDER = 'totally-made-up'
    expect(isFlowConfigured()).toBe(false)
  })

  it('settle asset defaults to USDC, overridable', () => {
    expect(flowSettleAsset()).toBe('USDC')
    process.env.NEXT_PUBLIC_FLOW_SETTLE_ASSET = 'EURC'
    expect(flowSettleAsset()).toBe('EURC')
  })
})

describe('prepareFlowSwap — fail-soft, never throws, never overclaims', () => {
  it('UNCONFIGURED ⇒ not_configured WITHOUT touching the adapter', async () => {
    // Inject an adapter that would FAIL the test if called — proves no swap probe.
    const adapter: SwapAdapter = {
      swapToSettlement: vi.fn(async () => {
        throw new Error('must not be called')
      }),
    }
    const r = await prepareFlowSwap(input(), adapter)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
    expect(adapter.swapToSettlement).not.toHaveBeenCalled()
  })

  it('CONFIGURED + the DEFAULT stub adapter ⇒ swap_adapter_unavailable (no claim)', async () => {
    configure()
    // No adapter passed ⇒ the default stub ⇒ honest "not swapping".
    const r = await prepareFlowSwap(input())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('swap_adapter_unavailable')
      // The honest reason names no swap/settlement as having happened.
      expect(r.reason).toMatch(/no funds moved|no token was swapped/i)
    }
  })

  it('builds for EVERY known provider but still reports the stub is unavailable', async () => {
    for (const provider of KNOWN_FLOW_PROVIDERS) {
      configure(provider)
      const r = await prepareFlowSwap(input())
      expect(r.ok, `provider ${provider}`).toBe(false)
      if (!r.ok) expect(r.code).toBe('swap_adapter_unavailable')
    }
  })

  it('rejects a malformed recipient address (never a guessed address)', async () => {
    configure()
    const r = await prepareFlowSwap(input({ address: '0xnope' as `0x${string}` }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_input')
  })

  it('rejects a malformed input-token address', async () => {
    configure()
    const r = await prepareFlowSwap(
      input({ inputToken: { address: '0xbad' as `0x${string}`, amount: '1' } }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_input')
  })

  it('rejects a non-positive / malformed amount (never a guessed amount)', async () => {
    configure()
    for (const bad of ['', '0', '-1', 'abc']) {
      const r = await prepareFlowSwap(
        input({ inputToken: { address: TOKEN, amount: bad } }),
      )
      expect(r.ok, `amount ${JSON.stringify(bad)}`).toBe(false)
      if (!r.ok) expect(r.code).toBe('invalid_input')
    }
  })

  it('CONFIGURED + an injected real adapter ⇒ surfaces the swap result as-is', async () => {
    configure('uniswap')
    const swapToSettlement = vi.fn(async () => ({
      settledAmount: '12.48',
      routeRef: 'route-abc',
      txHash: TOKEN,
    }))
    const r = await prepareFlowSwap(input(), { swapToSettlement })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.provider).toBe('uniswap')
      expect(r.settleAsset).toBe('USDC')
      expect(r.settledAmount).toBe('12.48')
      expect(r.routeRef).toBe('route-abc')
    }
    // The recipient + input rode through to the adapter unchanged.
    expect(swapToSettlement).toHaveBeenCalledWith(input(), 'USDC')
  })

  it('a thrown adapter error fails soft as swap_failed (clean, no throw)', async () => {
    configure()
    const adapter: SwapAdapter = {
      swapToSettlement: vi.fn(async () => {
        throw new Error('route expired')
      }),
    }
    const r = await prepareFlowSwap(input(), adapter)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('swap_failed')
  })

  it('never leaks the server key into a result', async () => {
    configure()
    process.env.FLOW_SERVER_KEY = 'sk_super_secret_value'
    const r = await prepareFlowSwap(input())
    expect(JSON.stringify(r)).not.toContain('sk_super_secret_value')
  })
})

describe('the default stub adapter is honest about doing nothing', () => {
  it('throws a recoverable, secret-free SwapAdapterUnavailableError', async () => {
    await expect(unavailableSwapAdapter.swapToSettlement(input(), 'USDC')).rejects.toBeInstanceOf(
      SwapAdapterUnavailableError,
    )
    try {
      await unavailableSwapAdapter.swapToSettlement(input(), 'USDC')
    } catch (err) {
      const e = err as SwapAdapterUnavailableError
      expect(e.recoverable).toBe(true)
      expect(e.code).toBe('swap_adapter_unavailable')
      // No guessed address in the message.
      expect(e.message).not.toMatch(/0x[0-9a-fA-F]{40}/)
    }
  })
})
