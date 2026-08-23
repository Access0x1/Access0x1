/**
 * lastPayment.ts — **Proof of Payment**: "did it land?", answered from the chain.
 *
 * THE FEATURE. Every merchant's first question after a checkout is the same one:
 * *did the money actually arrive?* Today the honest answer needs a block explorer,
 * a contract address, and knowing which event to look for. Proof of Payment turns
 * that into one call: give it a merchant id, get back the LAST settlement that
 * actually happened on-chain — amount, buyer, token, order id, block, and the tx
 * hash anyone can verify themselves.
 *
 * WHY IT'S BUILT AS A READ, NOT A CONTRACT CHANGE. The router already emits
 * `PaymentReceived` on every settled payment (it is the event CRE and indexers key
 * on). Storing a "last payment" pointer on-chain would cost every payer extra gas
 * forever to serve a question that the logs already answer for free. So this reads
 * history instead of writing more of it: **no contract change, no redeploy, and it
 * works on every chain the router is already live on.** Cheaper for the payer,
 * available today.
 *
 * DOCTRINE:
 *   - OFF THE MONEY PATH (law 2). This is a read. It never signs, never settles,
 *     and a failure here can never block or alter a payment.
 *   - FAIL-SOFT (law 1). No router configured for the chain, an RPC that refuses,
 *     or simply no payments yet ⇒ a clean `{ found: false, reason }`. It never
 *     throws at the caller and never invents a receipt (law 4: a payment we cannot
 *     prove is not reported as a payment).
 *   - NO HARDCODED ADDRESSES (law 3). The router address comes from the per-chain
 *     config the rest of the app uses.
 */

import type { Address, Hex, PublicClient } from 'viem'

/** The `PaymentReceived` event, exactly as `Access0x1Router` declares it. */
export const PAYMENT_RECEIVED_EVENT = {
  type: 'event',
  name: 'PaymentReceived',
  inputs: [
    { name: 'merchantId', type: 'uint256', indexed: true },
    { name: 'buyer', type: 'address', indexed: true },
    { name: 'token', type: 'address', indexed: true },
    { name: 'grossAmount', type: 'uint256', indexed: false },
    { name: 'feeAmount', type: 'uint256', indexed: false },
    { name: 'netAmount', type: 'uint256', indexed: false },
    { name: 'usdAmount8', type: 'uint256', indexed: false },
    { name: 'orderId', type: 'bytes32', indexed: false },
    { name: 'srcChainSelector', type: 'uint64', indexed: false },
  ],
} as const

/**
 * How far back to look, in blocks. A bounded window keeps this a cheap, predictable
 * single RPC call on any provider — an unbounded `fromBlock: 0` scan is what gets a
 * public endpoint to hang up. ~50k blocks is roughly a week of Ethereum-paced chains.
 */
export const DEFAULT_LOOKBACK_BLOCKS = 50_000n

/** A settlement, proven by its own transaction. */
export interface PaymentProof {
  found: true
  /** The merchant that was paid. */
  merchantId: bigint
  /** The wallet that paid. */
  buyer: Address
  /** The token paid in (the settlement asset). */
  token: Address
  /** Gross paid, in the token's own decimals. */
  grossAmount: bigint
  /** Fee taken, in the token's own decimals. */
  feeAmount: bigint
  /** Net delivered to the merchant, in the token's own decimals. */
  netAmount: bigint
  /** The USD price it was quoted at, 8-decimal fixed point. */
  usdAmount8: bigint
  /** The merchant's own order reference. */
  orderId: Hex
  /** 0 for a same-chain payment; the CCIP selector for a cross-chain one. */
  srcChainSelector: bigint
  /** THE PROOF: the transaction hash. Anyone can verify this independently. */
  txHash: Hex
  /** The block it settled in. */
  blockNumber: bigint
}

/** No settlement to report — always with an honest reason, never a fake receipt. */
export interface NoPaymentProof {
  found: false
  reason: 'not_configured' | 'no_payments_in_window' | 'lookup_failed'
  /** One human-readable line the UI can show verbatim. */
  detail: string
}

export type LastPaymentResult = PaymentProof | NoPaymentProof

/** What the lookup needs. `router` blank/absent ⇒ the seam is off for that chain. */
export interface LastPaymentInput {
  /** The router address for this chain (from config — never hardcoded). */
  router?: Address | null
  /** The merchant to prove payment for. Omit to match ANY merchant on the rail. */
  merchantId?: bigint
  /** How many blocks back to search. Defaults to {@link DEFAULT_LOOKBACK_BLOCKS}. */
  lookbackBlocks?: bigint
}

/**
 * Find the most recent settled payment and return it with its transaction hash.
 *
 * Reads `PaymentReceived` logs over a bounded recent window and returns the LAST
 * one (logs come back in ascending order, so the last entry is the newest). Never
 * throws: every failure path resolves to `{ found: false }` with a reason.
 *
 * @param client viem public client for the chain to search.
 * @param input  router address (from config), optional merchant filter, window size.
 * @returns The proven last payment, or an honest "nothing to show" with a reason.
 */
export async function lastPayment(
  client: Pick<PublicClient, 'getBlockNumber' | 'getLogs'>,
  input: LastPaymentInput,
): Promise<LastPaymentResult> {
  const router = (input.router ?? '') as string
  if (!router || !/^0x[0-9a-fA-F]{40}$/.test(router)) {
    return {
      found: false,
      reason: 'not_configured',
      detail: 'No Access0x1 router is configured for this chain, so there is nothing to read.',
    }
  }

  try {
    const head = await client.getBlockNumber()
    const lookback = input.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS
    // Clamp at 0: on a young chain head can be smaller than the window, and an
    // underflowed bigint would ask for an absurd fromBlock.
    const fromBlock = head > lookback ? head - lookback : 0n

    const logs = await client.getLogs({
      address: router as Address,
      event: PAYMENT_RECEIVED_EVENT,
      args: input.merchantId === undefined ? {} : { merchantId: input.merchantId },
      fromBlock,
      toBlock: head,
    })

    if (!logs.length) {
      return {
        found: false,
        reason: 'no_payments_in_window',
        detail: `No payment settled in the last ${lookback.toString()} blocks.`,
      }
    }

    // Ascending order — the newest settlement is the last entry.
    const log = logs[logs.length - 1] as (typeof logs)[number] & {
      args: Record<string, unknown>
      transactionHash: Hex | null
      blockNumber: bigint | null
    }
    const a = log.args as {
      merchantId?: bigint
      buyer?: Address
      token?: Address
      grossAmount?: bigint
      feeAmount?: bigint
      netAmount?: bigint
      usdAmount8?: bigint
      orderId?: Hex
      srcChainSelector?: bigint
    }

    // A log with no tx hash cannot be proven, so it is not reported as a payment.
    if (!log.transactionHash) {
      return {
        found: false,
        reason: 'lookup_failed',
        detail: 'A settlement was found but its transaction hash was missing, so it cannot be proven.',
      }
    }

    return {
      found: true,
      merchantId: a.merchantId ?? 0n,
      buyer: (a.buyer ?? '0x0000000000000000000000000000000000000000') as Address,
      token: (a.token ?? '0x0000000000000000000000000000000000000000') as Address,
      grossAmount: a.grossAmount ?? 0n,
      feeAmount: a.feeAmount ?? 0n,
      netAmount: a.netAmount ?? 0n,
      usdAmount8: a.usdAmount8 ?? 0n,
      orderId: (a.orderId ?? `0x${'00'.repeat(32)}`) as Hex,
      srcChainSelector: a.srcChainSelector ?? 0n,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber ?? 0n,
    }
  } catch (err) {
    return {
      found: false,
      reason: 'lookup_failed',
      detail: err instanceof Error ? `Could not read the chain: ${err.message}` : 'Could not read the chain.',
    }
  }
}

/** Format a USD 8-decimal fixed-point amount as `$1,234.56` for display. */
export function formatUsd8(usdAmount8: bigint): string {
  const whole = usdAmount8 / 100_000_000n
  const cents = (usdAmount8 % 100_000_000n) / 1_000_000n
  return `$${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`
}
