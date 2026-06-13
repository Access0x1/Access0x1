'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { keccak256, toHex, type Address, type Hash } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { getRouterAddress, getUsdcAddress } from '@/lib/chains'
import { payToken, type Merchant, type PaymentReceivedEvent } from '@/lib/contracts'
import { fetchQuote, usdToAmount8 } from '@/lib/quote'
import { getWalletClient, getPublicClient } from '@/lib/wallet'
import { ConnectButton } from './ConnectButton'
import { ReceiptScreen } from './ReceiptScreen'

const USDC_SYMBOL = 'USDC'
const USDC_DECIMALS = 6 // ERC-20 USDC display decimals (the contract reads on-chain decimals in-tx)

/**
 * The hosted checkout card. Loads the merchant's name (passed from the page),
 * fetches a LIVE quote from /api/quote (re-fetched on mount), and pays via
 * `payToken(USDC)`. White-label: the merchant name is prominent; Access0x1 is
 * footer-only. Off-CEI — this calls payToken and stops; no swap/bridge.
 */
export function CheckoutCard({
  chainId,
  merchantId,
  merchant,
  merchantName,
  usdAmount,
  orderParam,
  returnUrl,
}: {
  chainId: number
  merchantId: bigint
  merchant: Merchant
  merchantName: string
  usdAmount: string
  orderParam?: string
  returnUrl?: string
}): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const usdAmount8 = usdToAmount8(Number(usdAmount))

  const [quoteDisplay, setQuoteDisplay] = useState<string | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [loadingQuote, setLoadingQuote] = useState(true)
  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<{ event: PaymentReceivedEvent; txHash: Hash } | null>(null)

  // Always fetch the quote fresh on mount — never show a stale price (law #4).
  const refreshQuote = useCallback(async () => {
    setLoadingQuote(true)
    setQuoteError(null)
    let usdc: Address
    try {
      usdc = getUsdcAddress(chainId)
    } catch (err) {
      setQuoteError(err instanceof Error ? err.message : 'USDC not configured.')
      setLoadingQuote(false)
      return
    }
    const result = await fetchQuote({
      chainId,
      merchantId,
      token: usdc,
      usdAmount8,
      decimals: USDC_DECIMALS,
    })
    if (result.error) {
      setQuoteError(result.error)
      setQuoteDisplay(null)
    } else {
      setQuoteDisplay(result.display ?? null)
    }
    setLoadingQuote(false)
  }, [chainId, merchantId, usdAmount8])

  useEffect(() => {
    void refreshQuote()
  }, [refreshQuote])

  async function handlePay(): Promise<void> {
    setPayError(null)
    if (!primaryWallet) {
      setPayError('Connect a wallet to pay.')
      return
    }
    if (!merchant.active) {
      setPayError('Access0x1__MerchantInactive')
      return
    }
    // Re-fetch the quote immediately before confirming so the price is current.
    await refreshQuote()
    if (quoteError) return

    setPaying(true)
    try {
      const routerAddress = getRouterAddress(chainId)
      const usdc = getUsdcAddress(chainId)
      const walletClient = await getWalletClient(primaryWallet)
      const publicClient = getPublicClient(chainId)
      const orderId = (orderParam
        ? keccak256(toHex(orderParam))
        : keccak256(toHex(Date.now().toString()))) as `0x${string}`

      const { txHash, receipt: event } = await payToken(
        walletClient,
        publicClient,
        routerAddress,
        usdc,
        { merchantId, usdAmount8, orderId },
      )
      setReceipt({ event, txHash })
    } catch (err) {
      setPayError(humanizeRevert(err))
    } finally {
      setPaying(false)
    }
  }

  if (receipt) {
    return (
      <ReceiptScreen
        receipt={receipt.event}
        txHash={receipt.txHash}
        chainId={chainId}
        tokenSymbol={USDC_SYMBOL}
        tokenDecimals={USDC_DECIMALS}
        returnUrl={returnUrl}
      />
    )
  }

  const payDisabled = paying || loadingQuote || quoteError !== null || !merchant.active

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{merchantName}</h1>
        <p className="text-sm text-neutral-500">Pay with crypto</p>
      </div>

      <div className="rounded-xl border border-neutral-200 p-5">
        <p className="text-4xl font-semibold text-ink">${usdAmount}</p>
        <p className="mt-1 text-sm text-neutral-500">
          {loadingQuote
            ? 'Fetching live quote…'
            : quoteError
              ? quoteError === 'OracleLib__StalePrice'
                ? 'Price feed stale — try again'
                : `Quote unavailable (${quoteError})`
              : quoteDisplay
                ? `≈ ${quoteDisplay} ${USDC_SYMBOL}`
                : null}
        </p>
      </div>

      {!merchant.active ? (
        <p className="text-sm text-red-600">This merchant is not currently accepting payments.</p>
      ) : null}

      {primaryWallet ? (
        <button
          type="button"
          onClick={() => void handlePay()}
          disabled={payDisabled}
          className="rounded-lg bg-rail px-4 py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {paying ? 'Confirming…' : `Pay $${usdAmount}`}
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-neutral-500">Connect a wallet to pay.</p>
          <ConnectButton />
        </div>
      )}

      {payError ? <p className="text-sm text-red-600">{payError}</p> : null}

      <p className="border-t border-neutral-100 pt-4 text-center text-xs text-neutral-400">
        Powered by Access0x1
      </p>
    </div>
  )
}

/** Pull a recognizable revert/custom-error name out of a thrown error, if present. */
function humanizeRevert(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const known = [
    'Access0x1__MerchantInactive',
    'Access0x1__MerchantNotFound',
    'Access0x1__TokenNotAllowed',
    'Access0x1__Underpaid',
    'Access0x1__InvalidPrice',
    'OracleLib__StalePrice',
  ]
  for (const name of known) {
    if (message.includes(name)) return name
  }
  if (/insufficient/i.test(message)) return 'Insufficient USDC balance for this payment.'
  return 'Payment failed. Please try again.'
}
