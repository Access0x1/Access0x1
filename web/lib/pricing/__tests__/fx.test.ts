/**
 * fx.test.ts — a euro price is a Chainlink read or it is nothing.
 *
 * The whole reason EUR pricing is allowed to exist here is that the rate comes from an
 * on-chain feed anyone can check at the same block, not from a server-side lookup the
 * buyer has to take on trust. So the tests that matter are the refusals: every case where
 * this returns null is a case where the alternative was charging someone using a number
 * we were not sure of.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { eurToUsd8, eurUsdRate8, isEurPricingConfigured, FX_MAX_AGE_SECONDS } from '../fx'

const CHAIN = 84532
const FEED = '0x' + 'a'.repeat(40)
const NOW = 1_800_000_000n

/**
 * A client double returning one round + decimals.
 *
 * Cast at the boundary: viem types `readContract`'s return against the ABI generic, which a
 * hand-written double cannot satisfy without reproducing that inference. The cast is
 * confined to this helper so the tests themselves stay honest about what they assert.
 */
type FxClient = Parameters<typeof eurUsdRate8>[0]

function client(answer: bigint, updatedAt: bigint, decimals = 8): FxClient {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'decimals' ? decimals : [1n, answer, updatedAt, updatedAt, 1n],
    ),
  } as unknown as FxClient
}

afterEach(() => vi.unstubAllEnvs())

function configure(): void {
  vi.stubEnv(`NEXT_PUBLIC_EUR_USD_FEED_${CHAIN}`, FEED)
}

describe('configuration', () => {
  it('is off until a feed address is set', () => {
    expect(isEurPricingConfigured(CHAIN)).toBe(false)
  })

  it('ignores a malformed address rather than trying to call it', () => {
    vi.stubEnv(`NEXT_PUBLIC_EUR_USD_FEED_${CHAIN}`, 'not-an-address')
    expect(isEurPricingConfigured(CHAIN)).toBe(false)
  })

  it('is on with a valid address', () => {
    configure()
    expect(isEurPricingConfigured(CHAIN)).toBe(true)
  })
})

describe('reading the rate', () => {
  it('returns the live rate scaled to 8 decimals', async () => {
    configure()
    // 1.0850 EUR/USD reported with 8 decimals.
    const rate = await eurUsdRate8(client(108_500_000n, NOW - 60n), CHAIN, NOW)
    expect(rate).toBe(108_500_000n)
  })

  it('normalizes a feed that does not report 8 decimals', async () => {
    configure()
    // Same rate, reported with 18 decimals — must scale DOWN to 8, not be trusted raw.
    const rate = await eurUsdRate8(client(1_085_000_000_000_000_000n, NOW - 60n, 18), CHAIN, NOW)
    expect(rate).toBe(108_500_000n)
  })

  it('returns null with no feed configured — never a guessed rate', async () => {
    expect(await eurUsdRate8(client(108_500_000n, NOW), CHAIN, NOW)).toBeNull()
  })

  it('refuses a non-positive answer', async () => {
    configure()
    expect(await eurUsdRate8(client(0n, NOW), CHAIN, NOW)).toBeNull()
    expect(await eurUsdRate8(client(-1n, NOW), CHAIN, NOW)).toBeNull()
  })

  it('refuses a round that never completed', async () => {
    configure()
    expect(await eurUsdRate8(client(108_500_000n, 0n), CHAIN, NOW)).toBeNull()
  })

  it('refuses a stale answer, on the same window the money path uses', async () => {
    configure()
    const tooOld = NOW - FX_MAX_AGE_SECONDS - 1n
    expect(await eurUsdRate8(client(108_500_000n, tooOld), CHAIN, NOW)).toBeNull()
    // Exactly at the boundary is still fresh.
    const atEdge = NOW - FX_MAX_AGE_SECONDS
    expect(await eurUsdRate8(client(108_500_000n, atEdge), CHAIN, NOW)).toBe(108_500_000n)
  })

  it('treats an RPC failure as a missing rate, not a zero one', async () => {
    configure()
    const broken = {
      readContract: vi.fn(async () => {
        throw new Error('RPC down')
      }),
    } as unknown as FxClient
    expect(await eurUsdRate8(broken, CHAIN, NOW)).toBeNull()
  })
})

describe('converting', () => {
  it('converts €25.00 at 1.0850 to the USD the router is asked for', () => {
    // 25 EUR * 1.085 = 27.125 USD
    expect(eurToUsd8(2_500_000_000n, 108_500_000n)).toBe(2_712_500_000n)
  })

  it('rounds UP so a truncation never short-changes the merchant', () => {
    // 0.00000001 EUR at 1.5 = 0.000000015 USD — must not floor to 1.
    expect(eurToUsd8(1n, 150_000_000n)).toBe(2n)
  })

  it('yields zero for a non-price rather than a wrong price', () => {
    expect(eurToUsd8(0n, 108_500_000n)).toBe(0n)
    expect(eurToUsd8(2_500_000_000n, 0n)).toBe(0n)
    expect(eurToUsd8(-5n, 108_500_000n)).toBe(0n)
  })
})
