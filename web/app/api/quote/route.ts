import { NextResponse } from 'next/server'
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, type Address } from 'viem'
import { getChain, getRouterAddress, getRpcUrl } from '@/lib/chains'
import { getQuote } from '@/lib/contracts'

export const dynamic = 'force-dynamic'

/**
 * GET /api/quote?chainId=5042002&merchantId=42&token=0x...&usdAmount8=2900000000
 *
 * Calls `router.quote()` via a server-side public client (no wallet needed, no
 * RPC key exposed to the browser). Returns the token amount as a string (bigint
 * is not JSON-safe). On a contract revert (e.g. stale price, token not allowed)
 * the revert NAME is surfaced so the checkout can show an honest error and
 * disable pay — never a silent wrong price (law #4).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const chainIdRaw = searchParams.get('chainId')
  const merchantIdRaw = searchParams.get('merchantId')
  const token = searchParams.get('token')
  const usdAmount8Raw = searchParams.get('usdAmount8')

  if (!chainIdRaw || !merchantIdRaw || !token || !usdAmount8Raw) {
    return NextResponse.json(
      { error: 'Missing required query params: chainId, merchantId, token, usdAmount8' },
      { status: 400 },
    )
  }

  let chainId: number
  let merchantId: bigint
  let usdAmount8: bigint
  try {
    chainId = Number(chainIdRaw)
    merchantId = BigInt(merchantIdRaw)
    usdAmount8 = BigInt(usdAmount8Raw)
  } catch {
    return NextResponse.json({ error: 'Invalid numeric query param' }, { status: 400 })
  }

  let routerAddress: Address
  try {
    routerAddress = getRouterAddress(chainId)
  } catch (err) {
    // env not set — surface loudly (test case #10), do not return a silent 200.
    const message = err instanceof Error ? err.message : 'router address not configured'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const client = createPublicClient({
    chain: getChain(chainId),
    transport: http(getRpcUrl(chainId)),
  })

  try {
    const tokenAmount = await getQuote(client, routerAddress, merchantId, token as Address, usdAmount8)
    return NextResponse.json({ tokenAmount: tokenAmount.toString() })
  } catch (err) {
    return NextResponse.json({ error: extractRevertName(err) }, { status: 200 })
  }
}

/** Pull a custom-error name (e.g. OracleLib__StalePrice) out of a viem contract revert. */
function extractRevertName(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.shortMessage
    }
    return err.shortMessage
  }
  return err instanceof Error ? err.message : 'quote failed'
}
