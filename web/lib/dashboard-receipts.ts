/**
 * dashboard-receipts.ts — the dashboard's "recent receipts" read, off the money
 * path. Two sources, in preference order:
 *
 *   1. The Graph subgraph (unbounded, the right source for history) — ONLY when
 *      NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL is set. Fail-soft: any error falls
 *      through to the chain read, never throws to the UI.
 *   2. A BOUNDED direct chain read. The old code used `fromBlock: 'earliest'`,
 *      which on range-capped public RPCs (Base Sepolia caps eth_getLogs at 2000
 *      blocks) returns an EMPTY list rather than an error — a silent "no
 *      payments" as the chain ages past the router deploy. We scan backward in
 *      sub-cap windows instead, newest first, until we have enough.
 *
 * This module is dependency-light + pure enough to unit-test the bounded-window
 * logic and the fail-soft subgraph parsing without a browser.
 */
import { parseAbiItem, type Address, type PublicClient } from 'viem'

export interface ReceiptRow {
  txHash: `0x${string}`
  buyer: Address
  gross: bigint
  usd8: bigint
  block: bigint
}

export const PAYMENT_RECEIVED_EVENT = parseAbiItem(
  'event PaymentReceived(uint256 indexed merchantId, address indexed buyer, address indexed token, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, uint256 usdAmount8, bytes32 orderId, uint64 srcChainSelector)',
)

// Stay under the public-RPC eth_getLogs range cap (Base Sepolia enforces 2000),
// and bound the window count so a sparse merchant can't fan a "recent receipts"
// view into hundreds of RPC calls — the subgraph is the unbounded source.
const WINDOW = 1800n
const MAX_WINDOWS = 60 // ~108k blocks of lookback before deferring to the subgraph
const WANT = 50

/** The configured subgraph query URL, or undefined when the seam is dormant. */
export function subgraphUrl(): string | undefined {
  const raw = (process.env.NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL ?? '').trim()
  return raw.length > 0 ? raw : undefined
}

/** Newest-first by block, capped at WANT. */
function newestFirst(rows: ReceiptRow[]): ReceiptRow[] {
  return rows
    .slice()
    .sort((a, b) => (a.block < b.block ? 1 : a.block > b.block ? -1 : 0))
    .slice(0, WANT)
}

/**
 * The merchant's last {WANT} receipts from the subgraph, if one is configured.
 * Returns null on ANY problem (unset env, network, GraphQL errors, bad shape) so
 * the caller falls back to the chain — an analytics read must never throw to the
 * UI or block the money path.
 */
export async function fetchReceiptsFromSubgraph(
  merchantId: bigint,
): Promise<ReceiptRow[] | null> {
  const url = subgraphUrl()
  if (!url) return null
  try {
    // The subgraph filters Payment by the router merchantId (a BigInt), newest
    // first. (The Merchant entity is keyed by the UTF-8 bytes of the decimal id,
    // e.g. "49" → 0x3439, but Payment.merchantId is the plain numeric filter.)
    const query = `query Receipts($mid: BigInt!) {
      payments(first: ${WANT}, orderBy: blockNumber, orderDirection: desc, where: { merchantId: $mid }) {
        transactionHash
        buyer
        grossAmount
        usdAmount8
        blockNumber
      }
    }`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { mid: merchantId.toString() } }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: {
        payments?: Array<{
          transactionHash: string
          buyer: string
          grossAmount: string
          usdAmount8: string
          blockNumber: string
        }>
      }
      errors?: unknown
    }
    if (json.errors != null || json.data?.payments == null) return null
    return json.data.payments.map((p) => ({
      txHash: p.transactionHash as `0x${string}`,
      buyer: p.buyer as Address,
      gross: BigInt(p.grossAmount),
      usd8: BigInt(p.usdAmount8),
      block: BigInt(p.blockNumber),
    }))
  } catch {
    return null
  }
}

/**
 * Bounded direct-chain fallback. Scans backward from the latest block in
 * ≤{WINDOW}-block windows (under the eth_getLogs range cap), newest first, until
 * it has {WANT} receipts or {MAX_WINDOWS} windows are exhausted. Never uses
 * `fromBlock: 'earliest'`, so a range-capped RPC can't silently return empty.
 */
export async function fetchReceiptsFromChain(
  client: PublicClient,
  routerAddress: Address,
  merchantId: bigint,
): Promise<ReceiptRow[]> {
  const latest = await client.getBlockNumber()
  const collected: ReceiptRow[] = []
  let toBlock = latest
  for (let i = 0; i < MAX_WINDOWS && collected.length < WANT && toBlock > 0n; i++) {
    const fromBlock = toBlock >= WINDOW ? toBlock - WINDOW + 1n : 0n
    const logs = await client.getLogs({
      address: routerAddress,
      event: PAYMENT_RECEIVED_EVENT,
      args: { merchantId },
      fromBlock,
      toBlock,
    })
    for (const log of logs) {
      collected.push({
        txHash: log.transactionHash,
        buyer: log.args.buyer as Address,
        gross: log.args.grossAmount as bigint,
        usd8: log.args.usdAmount8 as bigint,
        block: log.blockNumber,
      })
    }
    if (fromBlock === 0n) break
    toBlock = fromBlock - 1n
  }
  return newestFirst(collected)
}

/**
 * The dashboard receipts read: subgraph first when configured (fail-soft), else
 * the bounded chain read. Returns newest-first, capped at {WANT}.
 */
export async function loadReceipts(
  client: PublicClient,
  routerAddress: Address,
  merchantId: bigint,
): Promise<ReceiptRow[]> {
  const viaSubgraph = await fetchReceiptsFromSubgraph(merchantId)
  if (viaSubgraph !== null) return newestFirst(viaSubgraph)
  return fetchReceiptsFromChain(client, routerAddress, merchantId)
}
