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
import { TokenPicker } from './TokenPicker'
import { WorldIdGate } from './WorldIdGate'
import { SuperVerifiedBadge } from './verification/SuperVerifiedBadge'
import type { CheckoutMode, HumanVerifier } from '@/lib/branding/store'
import { TIER_INFO, tierMeets, type TrustTier } from '@/lib/verification/tiers'
import { loadProfile } from '@/lib/verification/client'
import {
  DEFAULT_PAY_TOKEN,
  defaultPayToken,
  payTokenBySymbol,
  resolvePayTokens,
  type PayTokenSymbol,
  type ResolvedPayToken,
} from '@/lib/tokens'

const USDC_SYMBOL = 'USDC'
// USDC display decimals are resolved PER CHAIN via `tokenDecimalsFor(chainId)`
// (18 on Arc's native USDC, 6 on the bridged-USDC L2s) — never hardcoded to 6,
// which would mis-render Arc amounts by 10^12. The contract reads on-chain
// decimals in-tx; this constant is for the display/receipt formatting only.
//
// MULTI-TOKEN: a buyer may pay in ANY allowlisted coin (USDC default, plus
// WETH/LINK/UNI/ENS/DAI/WBTC when configured on the chain). The picker sets which
// token we quote + settle in; USDC's address/decimals come from chains.ts (the
// existing per-chain USDC seam), every other token from lib/tokens.ts (env-driven,
// undefined-until-configured). The display decimals below are resolved PER TOKEN.

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
  requiredTier = 'standard',
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
  /**
   * The minimum Super Verification trust tier the BUYER must hold to pay
   * ('standard' = anyone, the default). Composes with the World ID gate: the pay
   * button stays disabled until the connected buyer meets this tier. Off the
   * money path — purely a precondition in front of pay, like the World ID gate.
   */
  requiredTier?: TrustTier
}): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const usdAmount8 = usdToAmount8(Number(usdAmount))

  // The pay-token menu for THIS chain (USDC first; others disabled until env-set).
  const payTokens = resolvePayTokens(chainId)
  // Open on USDC when configured; else the first configured token; else USDC meta.
  const initialSymbol = (defaultPayToken(chainId)?.symbol ?? DEFAULT_PAY_TOKEN) as PayTokenSymbol
  const [tokenSymbol, setTokenSymbol] = useState<PayTokenSymbol>(initialSymbol)
  const selectedToken: ResolvedPayToken | undefined =
    payTokens.find((t) => t.symbol === tokenSymbol) ??
    (() => {
      const meta = payTokenBySymbol(tokenSymbol)
      return meta ? { ...meta, address: undefined, feed: undefined, available: false } : undefined
    })()

  // Display decimals for the SELECTED token. USDC is per-chain (Arc native = 18,
  // L2 USDC = 6, the "Arc trap"); every other token uses its canonical decimals.
  // The on-chain money path always reads `decimals()` in-tx — this is display-only.
  const tokenDecimals =
    tokenSymbol === USDC_SYMBOL ? tokenDecimalsFor(chainId) : (selectedToken?.decimals ?? 18)

  // World ID gate state: when the merchant requires verified humans, the pay
  // button stays disabled until the buyer completes the one-tap proof.
  const [humanVerified, setHumanVerified] = useState(checkoutMode !== 'verified-human')

  // Buyer trust tier (Super Verification): when the merchant requires a tier,
  // fetch the connected buyer's profile and gate pay until they meet it.
  const needsTier = requiredTier !== 'standard'
  const [buyerTier, setBuyerTier] = useState<TrustTier>('standard')
  const [buyerScore, setBuyerScore] = useState(0)
  const tierMet = !needsTier || tierMeets(buyerTier, requiredTier)

  const refreshTier = useCallback(async () => {
    const addr = primaryWallet?.address
    if (!needsTier || !addr) return
    const profile = await loadProfile(addr.toLowerCase())
    if (profile) {
      setBuyerTier(profile.tier)
      setBuyerScore(profile.score)
    }
  }, [needsTier, primaryWallet?.address])

  useEffect(() => {
    void refreshTier()
  }, [refreshTier])

  const [quoteDisplay, setQuoteDisplay] = useState<string | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [loadingQuote, setLoadingQuote] = useState(true)
  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<{ event: PaymentReceivedEvent; txHash: Hash } | null>(null)

  // Resolve the SELECTED token's on-chain address. USDC comes from the existing
  // per-chain seam (chains.ts); every other coin from the env-driven token set.
  // Throws (never a guessed address) when the selected coin isn't configured here.
  const resolveTokenAddress = useCallback((): Address => {
    if (tokenSymbol === USDC_SYMBOL) return getUsdcAddress(chainId)
    if (selectedToken?.address) return selectedToken.address
    throw new Error(`${tokenSymbol} is not available on this chain.`)
  }, [tokenSymbol, chainId, selectedToken?.address])

  // Always fetch the quote fresh on mount / token-change — never a stale price (law #4).
  const refreshQuote = useCallback(async () => {
    setLoadingQuote(true)
    setQuoteError(null)
    let token: Address
    try {
      token = resolveTokenAddress()
    } catch (err) {
      setQuoteError(err instanceof Error ? err.message : `${tokenSymbol} not configured.`)
      setQuoteDisplay(null)
      setLoadingQuote(false)
      return
    }
    const result = await fetchQuote({
      chainId,
      merchantId,
      token,
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
  }, [chainId, merchantId, usdAmount8, tokenDecimals, resolveTokenAddress, tokenSymbol])

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
    if (needsTier && !tierMet) {
      // Same precondition shape: the buyer-tier gate sits in front of pay, off
      // the money path. Re-check live in case they just verified in another tab.
      await refreshTier()
      if (!tierMeets(buyerTier, requiredTier)) {
        setPayError(`This merchant accepts ${TIER_INFO[requiredTier].label} buyers only.`)
        return
      }
    }
    // Re-fetch the quote immediately before confirming so the price is current.
    await refreshQuote()
    if (quoteError) return

    setPaying(true)
    try {
      const routerAddress = getRouterAddress(chainId)
      // Settle in the SELECTED allowlisted token (USDC default). The Router's
      // payToken(any allowlisted token) prices it via that token's Chainlink feed.
      const token = resolveTokenAddress()
      const walletClient = await getWalletClient(primaryWallet)
      const publicClient = getPublicClient(chainId)
      const orderId = (orderParam
        ? keccak256(toHex(orderParam))
        : keccak256(toHex(Date.now().toString()))) as `0x${string}`

      const { txHash, receipt: event } = await payToken(
        walletClient,
        publicClient,
        routerAddress,
        token,
        { merchantId, usdAmount8, orderId },
      )
      setReceipt({ event, txHash })
    } catch (err) {
      setPayError(humanizeRevert(err, tokenSymbol))
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
        tokenSymbol={tokenSymbol}
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
    (needsHuman && !humanVerified) ||
    (needsTier && !tierMet)

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
                ? `≈ ${quoteDisplay} ${tokenSymbol}`
                : null}
        </p>
        {/* Truth-in-copy (law #4): only claim "no separate gas" on a chain where
            USDC IS the native gas token (Arc) AND the buyer is paying IN USDC.
            Paying in another coin (WETH/LINK/…) still needs the chain's gas asset,
            so we never show this for a non-USDC selection. */}
        {isGasFree(chainId) && tokenSymbol === USDC_SYMBOL ? (
          <p className="mt-1 text-xs text-neutral-400">Pay in USDC — no separate gas token needed.</p>
        ) : null}
      </div>

      {!merchant.active ? (
        <p className="text-sm text-red-600">This merchant is not currently accepting payments.</p>
      ) : null}

      {/* Multi-token picker: the buyer chooses which allowlisted coin to pay in.
          USDC is the default; coins not configured on this chain show DISABLED
          with an honest note. Off the money path — it only sets which token we
          quote + settle in. Re-selecting re-fetches the quote (refreshQuote dep). */}
      <TokenPicker
        tokens={payTokens}
        selected={tokenSymbol}
        onSelect={(symbol) => {
          setTokenSymbol(symbol)
          setPayError(null)
        }}
        disabled={paying}
      />

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

      {primaryWallet && needsTier ? (
        // Buyer-tier gate (Super Verification): a precondition in front of pay,
        // off the money path. Shows the buyer's current rung; when it's below the
        // merchant's requirement, pay stays disabled and we point them to /verify.
        <div
          data-required-tier={requiredTier}
          data-tier-met={tierMet}
          className={`flex flex-col gap-2 rounded-xl border p-4 ${
            tierMet ? 'border-green-300 bg-green-50' : 'border-neutral-200 bg-neutral-50'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-neutral-600">
              {tierMet
                ? 'You meet this merchant’s verification requirement.'
                : `This merchant accepts ${TIER_INFO[requiredTier].label} buyers.`}
            </span>
            <SuperVerifiedBadge tier={buyerTier} score={buyerScore} />
          </div>
          {!tierMet ? (
            <a
              href="/verify"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                // Re-check when they come back from verifying in the new tab.
                setTimeout(() => void refreshTier(), 0)
              }}
              className="self-start rounded-lg border border-rail px-3 py-2 text-sm font-medium text-rail hover:opacity-90"
            >
              Get {TIER_INFO[requiredTier].label} →
            </a>
          ) : null}
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

/**
 * Pull a recognizable revert/custom-error name out of a thrown error, if present.
 * The insufficient-balance message names the SELECTED token (USDC default) so the
 * buyer is told the right coin to top up — never a hardcoded "USDC" when paying in
 * another allowlisted coin (law #4 truth-in-copy).
 */
function humanizeRevert(err: unknown, tokenSymbol: string = USDC_SYMBOL): string {
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
  if (/insufficient/i.test(message)) return `Insufficient ${tokenSymbol} balance for this payment.`
  return 'Payment failed. Please try again.'
}
