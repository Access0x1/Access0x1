import { NextResponse } from 'next/server'
import { createPublicClient, http, toHex, type Address, type PublicClient } from 'viem'
import { getChain, getRouterAddress, getRpcUrl } from '@/lib/chains'
import { getQuote, NATIVE_TOKEN } from '@/lib/contracts'
import { buildReport, classifyRegime, LogoError } from '@/lib/onchain-svg/report'

export const dynamic = 'force-dynamic'

/**
 * The public simulator's own upload ceiling — deliberately far below the
 * branding sanitizer's 256 KB cap. This route is unauthenticated and the
 * scrub is super-linear on hostile nested input, so a small cap bounds the
 * CPU any anonymous POST can spend. Real SVG logos are a few KB.
 */
const SIM_MAX_SVG_BYTES = 64 * 1024

/**
 * POST /api/onchain-estimate  { chainId: number, svg: string }
 *
 * The "as if it just ran" simulator endpoint. NOTHING is broadcast — the
 * uploaded mark is sanitized with the branding scrubber, the four storage
 * strategies are priced from first principles (lib/onchain-svg/estimate), and
 * then a LIVE testnet node cross-checks the math three ways, each fail-soft:
 *
 *   1. `eth_estimateGas` of a zero-value self-send carrying the sanitized
 *      bytes as calldata — needs no role, no funds, cannot revert; the node's
 *      answer is compared against the legacy (EIP-2028) and floor (EIP-7623)
 *      predictions to REVEAL which pricing regime the chain actually runs.
 *   2. `eth_gasPrice` — the spot price the estimate is denominated at.
 *   3. the router's own Chainlink-guarded `quote($1.00 → native)` — the SAME
 *      oracle the payment rail settles with prices the estimate in USD.
 *
 * The pure report always returns; a dead RPC or stale oracle degrades to an
 * honest `live.errors` entry, never a 500 and never invented numbers (law #4).
 * Server-side so the browser never needs an RPC key (the /api/quote pattern).
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: { chainId?: unknown; svg?: unknown }
  try {
    body = (await request.json()) as { chainId?: unknown; svg?: unknown }
  } catch {
    return NextResponse.json({ error: 'Body must be JSON: { chainId, svg }' }, { status: 400 })
  }

  const { chainId, svg } = body
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: 'chainId must be a positive integer' }, { status: 400 })
  }
  if (typeof svg !== 'string' || svg.trim().length === 0) {
    return NextResponse.json({ error: 'svg must be a non-empty string' }, { status: 400 })
  }
  // Hard byte ceiling BEFORE the sanitizer runs. This endpoint is PUBLIC and
  // UNAUTHENTICATED, and the sanitizer's repeat-until-stable scrub is
  // super-linear on pathological nested input — so we refuse anything larger
  // than a real logo well BELOW the branding sanitizer's own 256 KB cap,
  // bounding the worst-case CPU an anonymous POST can spend. A hand-drawn SVG
  // logo is a few KB; 64 KB is already generous.
  if (svg.length > SIM_MAX_SVG_BYTES) {
    return NextResponse.json(
      { error: `Upload exceeds the ${SIM_MAX_SVG_BYTES / 1024} KB simulator limit — SVG logos are only a few KB.` },
      { status: 413 },
    )
  }

  // The pure math — always answered. Sanitizer rejections are honest 400s.
  let report
  try {
    report = buildReport(svg)
  } catch (err) {
    if (err instanceof LogoError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  // The live cross-check — every part fail-soft, never blocks the math.
  const errors: string[] = []
  let selfSendGas: bigint | null = null
  let gasPriceWei: bigint | null = null
  let weiPerUsd: bigint | null = null

  let client: PublicClient | null = null
  try {
    client = createPublicClient({ chain: getChain(chainId), transport: http(getRpcUrl(chainId)) })
  } catch (err) {
    errors.push(err instanceof Error ? err.message : `Chain ${chainId} is not configured`)
  }

  if (client) {
    // A dead address on both ends: zero-value, no code to run, no role needed.
    const probe: Address = '0x000000000000000000000000000000000000dEaD'
    const data = toHex(new TextEncoder().encode(report.sanitizedSvg))
    const [gasRes, priceRes, usdRes] = await Promise.allSettled([
      client.estimateGas({ account: probe, to: probe, data }),
      client.getGasPrice(),
      routerWeiPerUsd(client, chainId),
    ])
    if (gasRes.status === 'fulfilled') selfSendGas = gasRes.value
    else errors.push(`live estimateGas failed: ${reason(gasRes.reason)}`)
    if (priceRes.status === 'fulfilled') gasPriceWei = priceRes.value
    else errors.push(`gas price unavailable: ${reason(priceRes.reason)}`)
    if (usdRes.status === 'fulfilled') weiPerUsd = usdRes.value
    else errors.push(`USD rate unavailable: ${reason(usdRes.reason)}`)
  }

  const regime =
    selfSendGas !== null
      ? classifyRegime(selfSendGas, BigInt(report.predictedLegacy), BigInt(report.predictedFloor))
      : null

  return NextResponse.json({
    ...report,
    live: {
      chainId,
      selfSendGas: selfSendGas?.toString() ?? null,
      gasPriceWei: gasPriceWei?.toString() ?? null,
      weiPerUsd: weiPerUsd?.toString() ?? null,
      regime,
      errors,
    },
  })
}

/**
 * How many wei one dollar buys, from the router's own oracle-guarded quote of
 * $1.00 in the native token (`quote(0, address(0), 1e8)` — the merchant arg is
 * unused by the price path). Throws through to the fail-soft collector.
 */
async function routerWeiPerUsd(client: PublicClient, chainId: number): Promise<bigint> {
  const router = getRouterAddress(chainId)
  return getQuote(client, router, 0n, NATIVE_TOKEN, 100_000_000n)
}

/** Human-safe failure text for the live.errors list. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown error'
}
