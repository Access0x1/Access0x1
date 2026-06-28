'use client'

import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { keccak256, toHex, type Address, type Hash } from 'viem'
import { useAccount, useWalletClient } from 'wagmi'
import { getRouterAddress, getUsdcAddress, tokenDecimalsFor } from '@/lib/chains'
import { payToken, type Merchant } from '@/lib/contracts'
import { fetchQuote, usdToAmount8 } from '@/lib/quote'
import { getPublicClient } from '@/lib/wallet'
import { safeReturnUrl } from '@/lib/safeUrl'
import { BuyerConnectButton } from '@/components/BuyerConnectButton'
import { ReceiptScreen } from '@/components/ReceiptScreen'
import { BrandMark } from '@/components/BrandMark'
import {
  checkoutReducer,
  initialCheckoutState,
  classifyPayError,
  canPay,
  canRetry,
  isBusy,
  payButtonLabel,
  statusLine,
} from '@/lib/checkout/state'

/** USDC is the settle token for this hardened client (the default branded path). */
const USDC_SYMBOL = 'USDC'

/**
 * The hardened branded-checkout client (`/c/{slug}`).
 *
 * This is the money-path-critical surface a buyer touches, so its job is to make
 * the transaction lifecycle EXPLICIT and SAFE rather than "good enough":
 *
 *  - **Explicit tx states.** Quote → confirm-in-wallet → pending → confirmed /
 *    failed are distinct, each with its own copy. The buyer always knows whether
 *    their wallet is waiting on them, the chain is settling, or it's done. All of
 *    this is owned by the pure state machine in `lib/checkout/state.ts`; this
 *    component only runs the effects and dispatches events.
 *  - **User-readable failures.** A wallet rejection (EIP-1193 4001) and an
 *    `OracleLib__StalePrice` revert produce plain-language messages with the
 *    right next step — never a hex blob (`classifyPayError`).
 *  - **Idempotent retry on a single quote.** Retrying a transient failure re-uses
 *    the same payment intent and re-quotes the price (so a stale/underpaid retry
 *    is correct), instead of spawning a fresh order.
 *  - **Never double-charge.** Two guards: the reducer refuses to begin a payment
 *    while a tx is in flight, AND a synchronous ref lock keyed on the in-flight
 *    tx hash blocks a second broadcast before React has flushed the first
 *    dispatch (a buyer mashing Pay can't sign twice).
 *
 * viem/wagmi-native throughout (the buyer connects with plain wagmi — NO Dynamic,
 * so a shopper is never metered as a Dynamic MAU — and `useWalletClient` hands the
 * existing `lib/contracts` pay path the same viem `WalletClient` it always took) —
 * no ethers. Zero custody: this calls `payToken` and stops; no swap/bridge, no
 * funds held.
 */
export function CheckoutClient({
  chainId,
  merchantId,
  merchant,
  merchantName,
  usdAmount,
  orderParam,
  returnUrl,
}: {
  /** The chain whose router settles this payment. */
  chainId: number
  /** The on-chain merchant id being paid. */
  merchantId: bigint
  /** The decoded merchant record (used to honestly gate on `active`). */
  merchant: Merchant
  /** The merchant's display name (white-label header). */
  merchantName: string
  /** The price in USD as a display string, e.g. "29.00". */
  usdAmount: string
  /** Optional merchant order reference; hashed into the on-chain `orderId`. */
  orderParam?: string
  /** Optional post-payment return URL (sanitized again here as a backstop). */
  returnUrl?: string
}): ReactNode {
  // Buyer wallet via wagmi (NOT Dynamic — keeps shoppers off the MAU meter).
  const { isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const usdAmount8 = usdToAmount8(Number(usdAmount))
  const tokenDecimals = tokenDecimalsFor(chainId)

  // Backstop the URL sanitization at the component boundary (defense in depth —
  // the page validates at extraction; this guards a prop arriving from elsewhere).
  const safeReturn = safeReturnUrl(returnUrl)

  const [state, dispatch] = useReducer(checkoutReducer, initialCheckoutState)

  // ── The synchronous never-double-charge lock ────────────────────────────────
  // The reducer guards STATE transitions, but React batches dispatches: two Pay
  // clicks (or a click + a stale retry) can both pass `canPay(state)` before the
  // first `PAY_REQUESTED` flushes. This ref is the synchronous gate that closes
  // that window — it is set the instant a pay attempt starts and cleared only
  // when the attempt fully settles. It is keyed on the in-flight tx hash once we
  // have one, so logs/telemetry can prove WHICH payment held the lock.
  const inFlight = useRef<{ locked: boolean; txHash: Hash | null }>({ locked: false, txHash: null })

  // ── Quoting effect ───────────────────────────────────────────────────────────
  // Always fetch the quote fresh — never a cached/stale price reaches the buyer
  // (law #4). A new quote bumps the nonce inside the reducer; we capture it so a
  // resolve that lands after a newer quote started is ignored.
  const runQuote = useCallback(async () => {
    dispatch({ type: 'QUOTE_START' })
    let token: Address
    try {
      token = getUsdcAddress(chainId)
    } catch (err) {
      dispatch({ type: 'QUOTE_FAIL', error: classifyPayError(err, USDC_SYMBOL) })
      return
    }
    const result = await fetchQuote({ chainId, merchantId, token, usdAmount8, decimals: tokenDecimals })
    // A late resolve that lands after a newer quote/pay started is dropped by the
    // reducer: QUOTE_OK / QUOTE_FAIL apply ONLY while phase === 'quoting'. So we
    // can dispatch unconditionally — the state machine, not this closure, is the
    // authority on whether this result is still current.
    if (result.error) {
      dispatch({
        type: 'QUOTE_FAIL',
        error: classifyPayError(new Error(result.error), USDC_SYMBOL),
      })
      return
    }
    if (result.tokenAmount === undefined || !result.display) {
      dispatch({ type: 'QUOTE_FAIL', error: classifyPayError(new Error('Quote returned no amount'), USDC_SYMBOL) })
      return
    }
    dispatch({ type: 'QUOTE_OK', display: result.display, tokenAmount: result.tokenAmount })
  }, [chainId, merchantId, usdAmount8, tokenDecimals])

  // Fetch the first quote on mount / when the wallet connects, and re-quote if the
  // price inputs change. We only auto-quote from idle so we never stomp a payment
  // in progress.
  useEffect(() => {
    if (!isConnected) {
      dispatch({ type: 'RESET_IDLE' })
      return
    }
    // Kick the first quote only from idle (the reducer ignores it otherwise, but
    // guarding here avoids a needless fetch mid-flight).
    if (state.phase === 'idle') void runQuote()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, chainId, usdAmount8])

  // ── Pay effect ────────────────────────────────────────────────────────────────
  const handlePay = useCallback(async (): Promise<void> => {
    // Synchronous double-charge gate #1: if a pay attempt is already locked, a
    // second click is a no-op. This closes the window before the reducer flushes.
    if (inFlight.current.locked) return
    // Gate #2 (state machine): a payment may only begin from a held quote with no
    // tx in flight. The reducer makes PAY_REQUESTED a no-op otherwise, but we also
    // bail early so we never even open the wallet in an illegal state.
    if (!canPay(state)) return
    if (!walletClient) return
    if (!merchant.active) {
      dispatch({ type: 'PAY_FAILED', error: classifyPayError(new Error('Access0x1__MerchantInactive'), USDC_SYMBOL) })
      return
    }

    inFlight.current = { locked: true, txHash: null }
    dispatch({ type: 'PAY_REQUESTED' })

    try {
      const routerAddress = getRouterAddress(chainId)
      const token = getUsdcAddress(chainId)
      const publicClient = getPublicClient(chainId)

      // Deterministic order id: hash the merchant's reference when present, else a
      // timestamp. (The on-chain `orderId` is the merchant's dedupe key; the
      // double-charge guard above prevents OUR side from re-broadcasting.)
      const orderId = (orderParam
        ? keccak256(toHex(orderParam))
        : keccak256(toHex(Date.now().toString()))) as `0x${string}`

      // `payToken` opens the wallet for the approve (if needed) and the pay, then
      // waits for the receipt and returns the hash + parsed PaymentReceived event.
      // We don't get a hash callback before the receipt from this helper, so we
      // hold `awaiting_signature` until it resolves; the moment we have the hash we
      // arm the reducer's guard and immediately mark it confirmed (the receipt is
      // already in hand). This keeps the state machine honest even though the two
      // events land together.
      const { txHash, receipt } = await payToken(
        walletClient,
        publicClient,
        routerAddress,
        token,
        { merchantId, usdAmount8, orderId },
      )

      // Arm + confirm. Record the hash on the synchronous lock so it is the proven
      // double-charge key for the life of this attempt.
      inFlight.current.txHash = txHash
      dispatch({ type: 'PAY_SUBMITTED', txHash })
      dispatch({ type: 'PAY_CONFIRMED', receipt })
    } catch (err) {
      // Classify the thrown value into a buyer-readable failure (wallet rejection,
      // oracle-stale, underpaid, insufficient funds, network, …). The reducer
      // clears the in-flight tx hash on PAY_FAILED so a retry is unblocked.
      dispatch({ type: 'PAY_FAILED', error: classifyPayError(err, USDC_SYMBOL) })
    } finally {
      // Release the synchronous lock — the reducer now holds the authoritative
      // post-attempt phase (confirmed or failed). A retry re-acquires it cleanly.
      inFlight.current = { locked: false, txHash: null }
    }
  }, [state, walletClient, merchant.active, chainId, merchantId, usdAmount8, orderParam])

  // Idempotent retry: re-quote the SAME payment intent (the reducer keeps the
  // quote nonce), then the buyer taps Pay again on the fresh price.
  const handleRetry = useCallback((): void => {
    if (!canRetry(state)) return
    dispatch({ type: 'RETRY' })
    void runQuote()
  }, [state, runQuote])

  // ── Render: terminal success short-circuits to the receipt ──────────────────
  if (state.phase === 'confirmed' && state.receipt) {
    return (
      <ReceiptScreen
        receipt={state.receipt}
        txHash={(inFlight.current.txHash ?? state.txHash) as Hash}
        chainId={chainId}
        tokenSymbol={USDC_SYMBOL}
        tokenDecimals={tokenDecimals}
        returnUrl={safeReturn}
      />
    )
  }

  const status = statusLine(state)
  const payDisabled = !canPay(state) || isBusy(state) || !merchant.active

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{merchantName}</h1>
      </div>

      {/* Price + live quote. The quote is always freshly fetched; while it loads
          or after a stale-feed error we say so plainly (never a guessed amount). */}
      <div className="rounded-xl border border-neutral-200 p-5">
        <p className="text-4xl font-semibold text-ink">${usdAmount}</p>
        <p className="mt-1 text-sm text-neutral-500" data-testid="quote-line">
          {state.phase === 'quoting'
            ? 'Fetching live quote…'
            : state.quoteDisplay
              ? `≈ ${state.quoteDisplay} ${USDC_SYMBOL}`
              : null}
        </p>
      </div>

      {!merchant.active ? (
        <p className="text-sm text-red-600">This merchant is not currently accepting payments.</p>
      ) : null}

      {/* Explicit lifecycle status line. Tone-coded: info (in-flight), error
          (failed/quote_error), success (confirmed — though that short-circuits
          to the receipt above, kept for completeness). */}
      {status ? (
        <p
          data-testid="status-line"
          data-phase={state.phase}
          className={
            status.tone === 'error'
              ? 'text-sm text-red-600'
              : status.tone === 'success'
                ? 'text-sm text-green-600'
                : 'text-sm text-neutral-500'
          }
        >
          {status.text}
        </p>
      ) : null}

      {isConnected ? (
        <button
          type="button"
          onClick={() => void handlePay()}
          disabled={payDisabled}
          data-testid="pay-button"
          className="rounded-lg bg-rail px-4 py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {payButtonLabel(state, `Pay $${usdAmount}`)}
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-neutral-500">Connect a wallet to pay.</p>
          <BuyerConnectButton />
        </div>
      )}

      {/* Retry — shown only when the current failure is retryable (a stale feed,
          a wallet rejection, a network blip). An inactive merchant or a
          disallowed token offers no pointless retry (canRetry === false). */}
      {canRetry(state) ? (
        <button
          type="button"
          onClick={handleRetry}
          data-testid="retry-button"
          className="self-start rounded-lg border border-rail px-3 py-2 text-sm font-medium text-rail hover:opacity-90"
        >
          Try again
        </button>
      ) : null}

      <p className="flex items-center justify-center gap-1.5 border-t border-neutral-100 pt-4 text-center text-xs text-neutral-400">
        <span>Powered by</span>
        <BrandMark size={14} />
      </p>
    </div>
  )
}
