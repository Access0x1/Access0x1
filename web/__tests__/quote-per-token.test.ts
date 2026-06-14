/**
 * @file quote-per-token.test.ts — the checkout quotes the SELECTED token, per token.
 *
 * Multi-token checkout reads `quote(merchantId, token, usdAmount8)` for whichever
 * allowlisted coin the buyer picked — NOT always USDC. This proves the per-token
 * quote path end to end at the lib layer:
 *   - the resolved token ADDRESS (env-driven) is the `token` the quote is fetched
 *     for (a LINK selection quotes LINK, not USDC),
 *   - the display is formatted in THAT token's decimals (WBTC=8 vs USDC=6 differ),
 *   - the same fixed USD price yields a different coin amount per feed.
 * The server feed math lives on-chain; here we pin the client wiring (law #4: the
 * buyer is shown the coin they actually pay in, in its own decimals).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchQuote, usdToAmount8 } from '../lib/quote.js'
import { payTokenBySymbol, resolvePayToken } from '../lib/tokens.js'

const CHAIN = 84532
const USD = usdToAmount8(29) // $29.00 → 2900000000n (8-dec router integer)

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env[`NEXT_PUBLIC_TOKEN_LINK_${CHAIN}`]
  delete process.env[`NEXT_PUBLIC_TOKEN_WBTC_${CHAIN}`]
})

/** Stub /api/quote to echo the `token` it was called with + return a fixed amount. */
function stubQuote(tokenAmount: string): { lastToken: () => string | null } {
  let lastUrl = ''
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      lastUrl = url
      return new Response(JSON.stringify({ tokenAmount }), { status: 200 })
    }),
  )
  return {
    lastToken: () => new URL(lastUrl, 'http://localhost').searchParams.get('token'),
  }
}

describe('per-token quote — the selected coin is what gets quoted', () => {
  it('a LINK selection quotes the LINK address (not USDC)', async () => {
    const linkAddr = '0x' + 'aa'.repeat(20)
    process.env[`NEXT_PUBLIC_TOKEN_LINK_${CHAIN}`] = linkAddr
    const link = resolvePayToken(payTokenBySymbol('LINK')!, CHAIN)
    expect(link.address).toBe(linkAddr)

    const probe = stubQuote('5000000000000000000') // 5 LINK (18-dec)
    const res = await fetchQuote({
      chainId: CHAIN,
      merchantId: 42n,
      token: link.address!,
      usdAmount8: USD,
      decimals: link.decimals,
    })
    expect(probe.lastToken()).toBe(linkAddr) // the LINK address, not a hardcoded USDC
    expect(res.display).toBe('5.00') // formatted in LINK's 18 decimals
  })

  it('formats each coin in ITS OWN decimals (WBTC 8-dec vs USDC 6-dec)', async () => {
    const wbtc = payTokenBySymbol('WBTC')!
    const usdc = payTokenBySymbol('USDC')!
    expect(wbtc.decimals).toBe(8)
    expect(usdc.decimals).toBe(6)

    // 0.00050000 WBTC (8-dec) for $29 (a ~$58k BTC) — formatted via the token decimals.
    stubQuote('50000')
    const wbtcRes = await fetchQuote({
      chainId: CHAIN,
      merchantId: 1n,
      token: ('0x' + 'bb'.repeat(20)) as `0x${string}`,
      usdAmount8: USD,
      decimals: wbtc.decimals,
    })
    expect(wbtcRes.display).toBe('0.00') // 50000 / 1e8, 2dp display

    // The SAME on-chain integer under USDC's 6 decimals reads very differently —
    // proving the decimals are per-token, never a shared constant.
    stubQuote('29000000')
    const usdcRes = await fetchQuote({
      chainId: CHAIN,
      merchantId: 1n,
      token: ('0x' + 'cc'.repeat(20)) as `0x${string}`,
      usdAmount8: USD,
      decimals: usdc.decimals,
    })
    expect(usdcRes.display).toBe('29.00') // 29000000 / 1e6
  })

  it('an unconfigured coin has no address to quote (caller must block, not guess)', () => {
    // WBTC unset on this chain → resolve gives undefined; the checkout surfaces a
    // "not available" error rather than quoting a guessed address (guardrail #5).
    const wbtc = resolvePayToken(payTokenBySymbol('WBTC')!, CHAIN)
    expect(wbtc.address).toBeUndefined()
    expect(wbtc.available).toBe(false)
  })
})
