'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { keccak256, toHex, type Address, type Hash } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { getRouterAddress, getUsdcAddress, isGasFree, tokenDecimalsFor } from '@/lib/chains'
import { payToken, type Merchant, type PaymentReceivedEvent } from '@/lib/contracts'
import { fetchQuote, usdToAmount8 } from '@/lib/quote'
import { getWalletClient, getPublicClient } from '@/lib/wallet'
import { ConnectButton } from './ConnectButton'
import { ReceiptScreen } from './ReceiptScreen'
import { WorldIdGate } from './WorldIdGate'
import type { CheckoutMode, HumanVerifier } from '@/lib/branding/store'

const USDC_SYMBOL = 'USDC'
// USDC display decimals are resolved PER CHAIN via `tokenDecimalsFor(chainId)`
// (18 on Arc's native USDC, 6 on the bridged-USDC L2s) — never hardcoded to 6,
// which would mis-render Arc amounts by 10^12. The contract reads on-chain
// decimals in-tx; this constant is for the display/receipt formatting only.

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
  checkoutMode = 'standard',
  humanVerifier = 'offchain',
}: {
  chainId: number
  merchantId: bigint
  merchant: Merchant
  merchantName: string
  usdAmount: string
  orderParam?: string
  returnUrl?: string
  /**
   * The merchant's D0 choice (World ID ADR). 'verified-human' requires a World
   * ID proof before pay; 'private'/'standard' leave the pay button as today.
   * The gate is OFF the money path — a verified-human merchant who isn't
   * configured degrades to standard upstream (`resolveGate`), never blocking pay.
   */
  checkoutMode?: CheckoutMode
  /** Where a verified-human proof is checked. 'onchain' is a documented seam (below). */
  humanVerifier?: HumanVerifier
}): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const usdAmount8 = usdToAmount8(Number(usdAmount))
  // Resolve USDC display decimals for THIS chain (Arc native = 18, L2 USDC = 6).
  const tokenDecimals = tokenDecimalsFor(chainId)

  // World ID gate state: when the merchant requires verified humans, the pay
  // button stays disabled until the buyer completes the one-tap proof.
  const [humanVerified, setHumanVerified] = useState(checkoutMode !== 'verified-human')

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
      decimals: tokenDecimals,
    })
    if (result.error) {
      setQuoteError(result.error)
      setQuoteDisplay(null)
    } else {
      setQuoteDisplay(result.display ?? null)
    }
    setLoadingQuote(false)
  }, [chainId, merchantId, usdAmount8, tokenDecimals])

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
    if (checkoutMode === 'verified-human' && !humanVerified) {
      // Precondition, not interception: the gate sits in FRONT of pay; it never
      // touches settlement (ADR D3 — off the money path by construction).
      setPayError('Please verify you’re a real person first.')
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
        tokenDecimals={tokenDecimals}
        returnUrl={returnUrl}
      />
    )
  }

  const needsHuman = checkoutMode === 'verified-human'
  const payDisabled =
    paying ||
    loadingQuote ||
    quoteError !== null ||
    !merchant.active ||
    (needsHuman && !humanVerified)

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
        {/* Truth-in-copy (law #4): only claim "no separate gas" on a chain where
            USDC IS the native gas token (Arc). Never shown on Base/ZKsync, where
            a USDC payment still needs ETH for gas. */}
        {isGasFree(chainId) ? (
          <p className="mt-1 text-xs text-neutral-400">Pay in USDC — no separate gas token needed.</p>
        ) : null}
      </div>

      {!merchant.active ? (
        <p className="text-sm text-red-600">This merchant is not currently accepting payments.</p>
      ) : null}

      {primaryWallet && needsHuman && !humanVerified ? (
        // Verified-humans-only checkout: the World ID gate stands in front of
        // pay. Off-chain verifier (default) posts the proof to /api/world/verify.
        // ON-CHAIN SEAM (ADR D3 / unit 5): when humanVerifier === 'onchain', a
        // future build calls Access0x1HumanGate.isCleared(merchantId, buyer)
        // (a free eth_call) here instead of the off-chain proof, gating on the
        // on-chain nullifier mapping. That gate is OFF the money path by
        // construction (Access0x1Receiver precedent) — never imported by the
        // Router. We build only the off-chain path here; the contract is a
        // documented seam, not built in this unit. `humanVerifier` is threaded
        // through so the swap is a branch, not a new prop.
        <div data-human-verifier={humanVerifier}>
          <WorldIdGate
            signal={primaryWallet.address}
            onVerified={() => setHumanVerified(true)}
          />
        </div>
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
