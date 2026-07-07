import type { Address } from 'viem'

/** Convert a human USD price (e.g. "29.00") to the 8-decimal integer the router uses. */
export function usdToAmount8(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8))
}

/**
 * Parse a URL-supplied USD amount (e.g. the `?amount=` param) into its 8-decimal
 * router integer, returning `null` for anything that isn't a real, positive
 * price. Guards the exact footguns the /api/quote route documents server-side:
 *   - `Number('abc')` / `Number('')`-ish junk → NaN → `usdToAmount8` would throw
 *     a RangeError ("NaN cannot be converted to a BigInt") at render time,
 *   - `1e999` → Infinity → same RangeError,
 *   - `1e308` (and any finite USD near MAX_VALUE): the INPUT is finite so the old
 *     `isFinite(usd)` guard passed, then `usd * 1e8` overflowed to Infinity and
 *     `BigInt(Infinity)` threw the very RangeError this guard exists to prevent —
 *     the scaled-result check below rejects it,
 *   - hex/octal/binary/leading-`+`/surrounding-whitespace/scientific strings
 *     (`0x64`, ` 100 `, `+50`, `1e3`): `Number()` silently coerces them to a value
 *     that mismatches the displayed price and charges the buyer the wrong amount —
 *     the plain-decimal syntax gate below rejects them,
 *   - a zero or negative price → `BigInt` silently accepts it (never quotable).
 * Returning `null` lets the checkout fail soft (show an honest error, disable
 * pay) instead of crashing the buyer-facing card or charging a wrong value
 * (law #4: never a wrong/blank price, never a hard crash on a malformed link).
 */
export function parseUsdAmount8(raw: string | null | undefined): bigint | null {
  if (raw == null) return null
  // Require plain-decimal syntax on the RAW input BEFORE Number() so that
  // hex/octal/binary/leading-`+`/surrounding-whitespace/scientific-notation are
  // rejected instead of silently coerced into a value that mismatches the price.
  // Matching the raw (not a trimmed copy) means ` 100 ` fails soft too, and
  // empty/whitespace-only input never matches → null, as before.
  if (!/^\d+(\.\d+)?$/.test(raw)) return null
  const usd = Number(raw)
  if (!Number.isFinite(usd) || usd <= 0) return null
  // Guard the SCALED result too (defense in depth): a finite USD near MAX_VALUE
  // overflows `*1e8` to Infinity, which `BigInt(Infinity)` would reject with a
  // RangeError at render. Reject it so no BigInt RangeError can ever occur.
  const scaled = Math.round(usd * 1e8)
  if (!Number.isFinite(scaled)) return null
  return BigInt(scaled)
}

/** Format an 8-decimal USD integer back to a display string (e.g. 2900000000n -> "29.00"). */
export function amount8ToUsd(amount8: bigint): string {
  const dollars = Number(amount8) / 1e8
  return dollars.toFixed(2)
}

/** Result of a quote fetch: either a token amount (in token decimals) or a surfaced revert reason. */
export interface QuoteResult {
  /** Token amount in the token's own decimals, as a bigint. Present on success. */
  tokenAmount?: bigint
  /** A formatted display string (e.g. "29.01 USDC") computed with `decimals`. */
  display?: string
  /** A surfaced error name (e.g. "OracleLib__StalePrice") or message on failure. */
  error?: string
}

/**
 * Fetch a live quote from the server `/api/quote` route. Always called fresh
 * (no caching) so a stale price never reaches the buyer (law #4). The server
 * holds the RPC; the client never sees an RPC key.
 *
 * @param chainId    The chain whose router to quote against.
 * @param merchantId The merchant being paid.
 * @param token      The pay-in token (USDC address, or zero address for native).
 * @param usdAmount8 The price in USD with 8 decimals.
 * @param decimals   The token's decimals, for formatting the display string.
 */
export async function fetchQuote(params: {
  chainId: number
  merchantId: bigint
  token: Address
  usdAmount8: bigint
  decimals: number
}): Promise<QuoteResult> {
  const { chainId, merchantId, token, usdAmount8, decimals } = params
  const qs = new URLSearchParams({
    chainId: String(chainId),
    merchantId: merchantId.toString(),
    token,
    usdAmount8: usdAmount8.toString(),
  })
  const res = await fetch(`/api/quote?${qs.toString()}`, { cache: 'no-store' })
  const body = (await res.json()) as { tokenAmount?: string; error?: string }
  if (!res.ok || body.error) {
    return { error: body.error ?? `Quote failed (${res.status})` }
  }
  if (!body.tokenAmount) return { error: 'Quote returned no amount' }
  const tokenAmount = BigInt(body.tokenAmount)
  return {
    tokenAmount,
    display: formatTokenAmount(tokenAmount, decimals),
  }
}

/** Format a bigint token amount to a fixed-2 display string in the token's decimals. */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  const divisor = 10 ** decimals
  return (Number(amount) / divisor).toFixed(2)
}
