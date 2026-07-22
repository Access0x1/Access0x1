/**
 * @file tokens.test.ts — the canonical SUPPORTED PAY-TOKEN set + per-chain resolve.
 *
 * A buyer may pay in any allowlisted coin (USDC default, plus WETH/LINK/UNI/ENS/
 * DAI/WBTC). This proves the static list is complete + ordered (USDC first), that
 * a token's address/feed are ENV-DRIVEN (`NEXT_PUBLIC_TOKEN_<SYM>_<chainId>` /
 * `NEXT_PUBLIC_TOKEN_<SYM>_FEED_<chainId>`), undefined-until-configured (never a
 * guessed address — doctrine guardrail #5), and that the zero address counts as
 * "not configured" (mirrors the deploy script's address(0) skip). USDC reuses the
 * existing per-chain USDC vars (no duplicate var).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PAY_TOKEN,
  SUPPORTED_PAY_TOKENS,
  defaultPayToken,
  payTokenBySymbol,
  resolvePayToken,
  resolvePayTokens,
  type PayTokenSymbol,
} from '../lib/tokens.js'

const CHAIN = 84532 // Base Sepolia — a chain WITH a zero-config USDC default
// A supported chain with NO zero-config USDC default (only Arc/Base/Eth-Sepolia
// carry one), so "USDC unset ⇒ unavailable" is a genuine, testable state here.
const NODEFAULT = 11155420 // OP Sepolia
const ALL_SYMBOLS: PayTokenSymbol[] = ['USDC', 'WETH', 'LINK', 'UNI', 'ENS', 'DAI', 'WBTC']

// Every env key these tests touch — cleaned after each so no test leaks into the next.
const ENV_KEYS = [CHAIN, NODEFAULT].flatMap((chain) => [
  `NEXT_PUBLIC_USDC_ADDRESS_${chain}`,
  `NEXT_PUBLIC_USDC_USD_FEED_${chain}`,
  ...ALL_SYMBOLS.filter((s) => s !== 'USDC').flatMap((s) => [
    `NEXT_PUBLIC_TOKEN_${s}_${chain}`,
    `NEXT_PUBLIC_TOKEN_${s}_FEED_${chain}`,
  ]),
])

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('SUPPORTED_PAY_TOKENS — the canonical list', () => {
  it('contains exactly the seven public coins, USDC first', () => {
    expect(SUPPORTED_PAY_TOKENS.map((t) => t.symbol)).toEqual(ALL_SYMBOLS)
    expect(DEFAULT_PAY_TOKEN).toBe('USDC')
    expect(SUPPORTED_PAY_TOKENS[0].symbol).toBe('USDC')
  })

  it('carries canonical decimals (WBTC=8, USDC=6, the rest 18)', () => {
    const dec = Object.fromEntries(SUPPORTED_PAY_TOKENS.map((t) => [t.symbol, t.decimals]))
    expect(dec.USDC).toBe(6)
    expect(dec.WBTC).toBe(8)
    for (const s of ['WETH', 'LINK', 'UNI', 'ENS', 'DAI'] as const) expect(dec[s]).toBe(18)
  })

  it('every token has a name and chain-keyed env resolvers', () => {
    for (const t of SUPPORTED_PAY_TOKENS) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.addressEnv(CHAIN)).toContain(String(CHAIN))
      expect(t.feedEnv(CHAIN)).toContain(String(CHAIN))
    }
  })

  it('USDC reuses the existing per-chain USDC vars (no duplicate var)', () => {
    const usdc = payTokenBySymbol('USDC')!
    expect(usdc.addressEnv(CHAIN)).toBe(`NEXT_PUBLIC_USDC_ADDRESS_${CHAIN}`)
    expect(usdc.feedEnv(CHAIN)).toBe(`NEXT_PUBLIC_USDC_USD_FEED_${CHAIN}`)
  })

  it('non-USDC tokens use NEXT_PUBLIC_TOKEN_<SYM>_<chainId>', () => {
    const link = payTokenBySymbol('LINK')!
    expect(link.addressEnv(CHAIN)).toBe(`NEXT_PUBLIC_TOKEN_LINK_${CHAIN}`)
    expect(link.feedEnv(CHAIN)).toBe(`NEXT_PUBLIC_TOKEN_LINK_FEED_${CHAIN}`)
  })
})

describe('resolvePayToken — env-driven, undefined until configured', () => {
  it('an unset token is { available: false, address: undefined } (never guessed)', () => {
    const link = payTokenBySymbol('LINK')!
    const r = resolvePayToken(link, CHAIN)
    expect(r.address).toBeUndefined()
    expect(r.feed).toBeUndefined()
    expect(r.available).toBe(false)
  })

  it('a configured token resolves its address + feed and is available', () => {
    process.env[`NEXT_PUBLIC_TOKEN_LINK_${CHAIN}`] = '0x' + '11'.repeat(20)
    process.env[`NEXT_PUBLIC_TOKEN_LINK_FEED_${CHAIN}`] = '0x' + '22'.repeat(20)
    const r = resolvePayToken(payTokenBySymbol('LINK')!, CHAIN)
    expect(r.address).toBe('0x' + '11'.repeat(20))
    expect(r.feed).toBe('0x' + '22'.repeat(20))
    expect(r.available).toBe(true)
  })

  it('the zero address counts as not configured (mirrors deploy address(0) skip)', () => {
    process.env[`NEXT_PUBLIC_TOKEN_UNI_${CHAIN}`] = '0x' + '00'.repeat(20)
    const r = resolvePayToken(payTokenBySymbol('UNI')!, CHAIN)
    expect(r.address).toBeUndefined()
    expect(r.available).toBe(false)
  })

  it('a feed without an address is still unavailable (address keys availability)', () => {
    process.env[`NEXT_PUBLIC_TOKEN_DAI_FEED_${CHAIN}`] = '0x' + '33'.repeat(20)
    const r = resolvePayToken(payTokenBySymbol('DAI')!, CHAIN)
    expect(r.available).toBe(false)
    expect(r.feed).toBe('0x' + '33'.repeat(20))
  })
})

describe('resolvePayTokens / defaultPayToken — the chain menu', () => {
  it('returns the full set in order (configured or not — honest menu)', () => {
    // NODEFAULT has no zero-config USDC, so with nothing set every token is
    // unavailable — the honest full menu with all rows disabled.
    const all = resolvePayTokens(NODEFAULT)
    expect(all.map((t) => t.symbol)).toEqual(ALL_SYMBOLS)
    expect(all.every((t) => t.available === false)).toBe(true) // nothing set this chain
  })

  it('USDC is available by default on a zero-config default chain (no env needed)', () => {
    // The client-inlined getUsdcAddress seam gives Base Sepolia a zero-config USDC
    // default, so a fresh clone's checkout offers USDC without any NEXT_PUBLIC env.
    // (Regression guard: the picker previously read a computed process.env key that
    // Next.js never inlines client-side, so USDC wrongly showed "not available".)
    const all = resolvePayTokens(CHAIN)
    const usdc = all.find((t) => t.symbol === 'USDC')
    expect(usdc?.available).toBe(true)
    expect(usdc?.address).toBeDefined()
  })

  it('defaultPayToken is USDC when USDC is configured', () => {
    process.env[`NEXT_PUBLIC_USDC_ADDRESS_${NODEFAULT}`] = '0x' + 'aa'.repeat(20)
    const d = defaultPayToken(NODEFAULT)
    expect(d?.symbol).toBe('USDC')
    expect(d?.available).toBe(true)
  })

  it('defaultPayToken falls back to the first configured token when USDC is unset', () => {
    // On a no-default chain, USDC unset ⇒ the fallback picks the first configured token.
    process.env[`NEXT_PUBLIC_TOKEN_WETH_${NODEFAULT}`] = '0x' + 'bb'.repeat(20)
    const d = defaultPayToken(NODEFAULT)
    expect(d?.symbol).toBe('WETH')
  })

  it('defaultPayToken is undefined when NO token is configured on the chain', () => {
    expect(defaultPayToken(NODEFAULT)).toBeUndefined()
  })
})
