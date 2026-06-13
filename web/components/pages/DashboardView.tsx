'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { parseAbiItem, type Address } from 'viem'
import { getDefaultChainId, getRouterAddress } from '@/lib/chains'
import { getPublicClient } from '@/lib/wallet'
import { amount8ToUsd, formatTokenAmount } from '@/lib/quote'
import { ConnectButton } from '@/components/ConnectButton'

const USDC_DECIMALS = 6

const PAYMENT_RECEIVED_EVENT = parseAbiItem(
  'event PaymentReceived(uint256 indexed merchantId, address indexed buyer, address indexed token, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, uint256 usdAmount8, bytes32 orderId, uint64 srcChainSelector)',
)

interface Row {
  txHash: string
  buyer: Address
  gross: bigint
  usd8: bigint
  block: bigint
}

/** Truncate an address for display. */
function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * Merchant receipt feed: the last 50 PaymentReceived events for the merchantId
 * stored at onboard time (localStorage), filtered by merchantId. Minimal:
 * block, amount, USD, buyer. Rendered client-only (route wrapper, ssr: false).
 */
export function DashboardView(): ReactNode {
  const chainId = getDefaultChainId()
  const [merchantId, setMerchantId] = useState<bigint | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      const stored = localStorage.getItem('ax1_merchant_id')
      if (stored) setMerchantId(BigInt(stored))
    } catch {
      // ignore
    }
  }, [])

  const load = useCallback(async () => {
    if (merchantId === null) return
    setLoading(true)
    setError(null)
    try {
      const routerAddress = getRouterAddress(chainId)
      const client = getPublicClient(chainId)
      const logs = await client.getLogs({
        address: routerAddress,
        event: PAYMENT_RECEIVED_EVENT,
        args: { merchantId },
        fromBlock: 'earliest',
        toBlock: 'latest',
      })
      const mapped: Row[] = logs
        .slice(-50)
        .reverse()
        .map((log) => ({
          txHash: log.transactionHash,
          buyer: log.args.buyer as Address,
          gross: log.args.grossAmount as bigint,
          usd8: log.args.usdAmount8 as bigint,
          block: log.blockNumber,
        }))
      setRows(mapped)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load receipts.')
    } finally {
      setLoading(false)
    }
  }, [chainId, merchantId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Receipts</h1>
        <ConnectButton />
      </header>

      {merchantId === null ? (
        <p className="text-sm text-neutral-500">
          No merchant found in this browser. Register on the onboard page first.
        </p>
      ) : (
        <>
          <p className="text-sm text-neutral-500">Merchant #{merchantId.toString()}</p>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          {loading ? (
            <div className="h-32 animate-pulse rounded-xl bg-neutral-100" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-neutral-500">No payments yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-neutral-500">
                  <th className="py-2 font-medium">Block</th>
                  <th className="py-2 font-medium">Amount</th>
                  <th className="py-2 font-medium">USD</th>
                  <th className="py-2 font-medium">Buyer</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.txHash}-${r.buyer}`} className="border-b border-neutral-100">
                    <td className="py-2 font-mono text-xs">{r.block.toString()}</td>
                    <td className="py-2">{formatTokenAmount(r.gross, USDC_DECIMALS)} USDC</td>
                    <td className="py-2">${amount8ToUsd(r.usd8)}</td>
                    <td className="py-2 font-mono text-xs">{short(r.buyer)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  )
}
