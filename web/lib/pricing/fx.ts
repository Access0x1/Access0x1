import type { PublicClient } from 'viem'

/**
 * fx.ts — price a checkout in EUR without ever inventing an exchange rate.
 *
 * The router prices in USD with 8 decimals (`usdAmount8`) and converts USD→token via that
 * token's Chainlink feed INSIDE the settlement transaction. So a euro price needs exactly
 * one more step, and it must be the same kind of step: read EUR/USD from a Chainlink
 * aggregator on-chain, and convert. No API, no cached rate, no number this app made up.
 *
 * That is what makes a euro price honest here. A server-side FX lookup would be a number
 * the buyer cannot check and the contract never saw; a Chainlink read is a value anyone
 * can verify at the same block. The rate is quoted for DISPLAY and for deriving the
 * `usdAmount8` the router is asked for — the router still re-prices USD→token in-tx, so
 * the settlement guarantee is unchanged.
 *
 * FAIL-SOFT, NEVER FAIL-WRONG. With no feed configured this returns null and the caller
 * shows USD only. A stale or non-positive answer returns null too. The one thing it will
 * not do is return a rate it is not sure of — a wrong FX rate is a wrong charge, and a
 * missing euro price is merely a missing feature.
 */

/** The two Chainlink methods needed to read a rate and judge whether to trust it. */
const AGGREGATOR_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const

/**
 * How old a EUR/USD answer may be before this refuses it, in seconds.
 *
 * One hour, matching `OracleLib`'s staleness window on the money path — the same number
 * on purpose, so a rate the display trusts and a rate the contract would trust cannot
 * diverge. FX moves slowly enough that an hour is generous and still safe.
 */
export const FX_MAX_AGE_SECONDS = 3600n

/** The EUR/USD aggregator for a chain, from env. Never hardcoded (law #3). */
export function eurUsdFeedAddress(chainId: number): string | null {
  const raw = (process.env[`NEXT_PUBLIC_EUR_USD_FEED_${chainId}`] ?? '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null
}

/** True when this deployment can quote a euro price at all. */
export function isEurPricingConfigured(chainId: number): boolean {
  return eurUsdFeedAddress(chainId) !== null
}

/**
 * Read EUR/USD from Chainlink and return it scaled to 8 decimals.
 *
 * @param client A viem public client for the chain the checkout settles on.
 * @param chainId The settlement chain (selects the configured feed).
 * @param nowSeconds Current unix time; injected so the staleness rule is testable.
 * @returns The rate as an 8-decimal integer (1.0850 EUR/USD → 108500000n), or null when
 *   no feed is configured, the answer is non-positive, or it is older than
 *   {@link FX_MAX_AGE_SECONDS}.
 */
export async function eurUsdRate8(
  client: Pick<PublicClient, 'readContract'>,
  chainId: number,
  nowSeconds: bigint,
): Promise<bigint | null> {
  const address = eurUsdFeedAddress(chainId)
  if (!address) return null

  try {
    const [round, decimals] = await Promise.all([
      client.readContract({
        address: address as `0x${string}`,
        abi: AGGREGATOR_ABI,
        functionName: 'latestRoundData',
      }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
      client.readContract({
        address: address as `0x${string}`,
        abi: AGGREGATOR_ABI,
        functionName: 'decimals',
      }) as Promise<number>,
    ])

    const answer = round[1]
    const updatedAt = round[3]

    // Same three guards OracleLib applies on the money path: a non-positive answer is
    // never a price, an unset timestamp means the round never completed, and an old
    // answer is a number from a feed that has stopped reporting.
    if (answer <= 0n) return null
    if (updatedAt === 0n) return null
    if (nowSeconds > updatedAt && nowSeconds - updatedAt > FX_MAX_AGE_SECONDS) return null

    // Normalize whatever the feed reports to 8 decimals.
    const d = BigInt(decimals)
    if (d === 8n) return answer
    return d > 8n ? answer / 10n ** (d - 8n) : answer * 10n ** (8n - d)
  } catch {
    // An RPC failure is a missing rate, not a zero one.
    return null
  }
}

/**
 * Convert a euro amount to the 8-decimal USD figure the router takes.
 *
 * @param eurAmount8 The price in EUR, 8 decimals (€25.00 → 2500000000n).
 * @param rate8 EUR/USD from {@link eurUsdRate8}, 8 decimals.
 * @returns usdAmount8, rounded UP so the merchant is never short-changed by a truncation —
 *   the same direction `quote()` rounds for the same reason.
 */
export function eurToUsd8(eurAmount8: bigint, rate8: bigint): bigint {
  if (eurAmount8 <= 0n || rate8 <= 0n) return 0n
  const scaled = eurAmount8 * rate8
  const unit = 10n ** 8n
  // Ceiling division: (a + b - 1) / b.
  return (scaled + unit - 1n) / unit
}
