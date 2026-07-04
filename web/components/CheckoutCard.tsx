'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { keccak256, toHex, type Address, type Hash } from 'viem'
import { useAccount, useWalletClient } from 'wagmi'
import { getRouterAddress, getUsdcAddress, isGasFree, tokenDecimalsFor } from '@/lib/chains'
import { payToken, type Merchant, type PaymentReceivedEvent } from '@/lib/contracts'
import { fetchQuote, usdToAmount8 } from '@/lib/quote'
import { getPublicClient } from '@/lib/wallet'
import { BrandMark } from './BrandMark'
import { BuyerConnectButton } from './BuyerConnectButton'
import { MerchantIdentity } from './MerchantIdentity'
import { FundButton } from './FundButton'
import { isOnrampPublicConfigured } from '@/lib/onramp'
import { isFlowPublicConfigured } from '@/lib/flow'
import { safeReturnUrl } from '@/lib/safeUrl'
import { isBlinkPublicConfigured, runBlinkDeposit } from '@/lib/funding/blink'
import { isPaymasterActiveForChain } from '@/lib/paymaster'
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
 *
 * BUYER WALLET = PLAIN WAGMI (no Dynamic). A customer paying here must never open
 * a Dynamic session — one Dynamic MAU is one BUSINESS, not one shopper. So this
 * card connects the buyer through wagmi (`useAccount` / `useWalletClient`, backed
 * by the EIP-6963/injected/WalletConnect connectors configured in providers.tsx)
 * and consumes the resulting viem `WalletClient` directly — exactly the
 * auth-agnostic path the published `@access0x1/react` SDK uses. Merchants keep
 * using Dynamic on the onboarding/dashboard routes; the customer path does not.
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
  // Buyer wallet via wagmi (NOT Dynamic): the connected address for reads/gates
  // and a viem WalletClient for the pay tx. `useWalletClient` returns exactly the
  // viem client `payToken` expects, so no Dynamic-specific adapter is needed.
  const { address: buyerAddress, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const usdAmount8 = usdToAmount8(Number(usdAmount))

  // Sanitize the merchant-supplied return URL ONCE, here, before it is forwarded
  // anywhere: rendered as the receipt's "Return to merchant" href OR sent to the
  // on-ramp as `redirectUrl`. Only an https: URL survives; a javascript:/data:/
  // http:/evil-origin value collapses to undefined so neither path forwards it
  // (red-report C-1 / O-11). The page already validates at extraction; this is
  // the in-component backstop in case the prop arrives from elsewhere.
  const safeReturn = safeReturnUrl(returnUrl)

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
    const addr = buyerAddress
    if (!needsTier || !addr) return
    const profile = await loadProfile(addr.toLowerCase())
    if (profile) {
      setBuyerTier(profile.tier)
      setBuyerScore(profile.score)
    }
  }, [needsTier, buyerAddress])

  useEffect(() => {
    void refreshTier()
  }, [refreshTier])

  const [quoteDisplay, setQuoteDisplay] = useState<string | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [loadingQuote, setLoadingQuote] = useState(true)
  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<{ event: PaymentReceivedEvent; txHash: Hash } | null>(null)

  // ── Funding seam (env-gated, fail-soft) ──────────────────────────────────────
  // "Get USDC into the wallet" two ways, BOTH off the money path: a hosted fiat
  // on-ramp (bank/card) and a one-tap crypto deposit. Visibility is gated on the
  // PUBLIC config only (the client can't see the server flags); the route/SDK do
  // the full check. Either path funds the connected EOA, which then pays via the
  // existing handlePay below — funding never settles a payment itself.
  const bankConfigured = isOnrampPublicConfigured()
  const oneTapConfigured = isBlinkPublicConfigured()
  // ERC-7677 paymaster: true ONLY when a paymaster is configured AND it covers
  // this checkout's chain. The badge is hidden on all other chains (law #4).
  const gasSponsored = isPaymasterActiveForChain(chainId)
  // Flow "pay in any token → USDC" OPTIONAL seam (default OFF). Visibility is
  // gated on the PUBLIC config only (NEXT_PUBLIC_FLOW_ENABLED + app id); when off
  // NOTHING changes — native/USDC pay behaves exactly as today. When on, the
  // option is surfaced but the SWAP STEP is a documented adapter/stub (lib/flow):
  // no aggregator SDK is wired yet, so the copy MUST NOT claim a token is
  // "swapped"/"settled" (law #4). It points the buyer at the existing token
  // picker / funding seam to top up in USDC until the swap adapter lands.
  const flowConfigured = isFlowPublicConfigured()
  const [funding, setFunding] = useState(false)
  const [fundNote, setFundNote] = useState<string | null>(null)

  const handleFundWithBank = useCallback(async (): Promise<void> => {
    setFundNote(null)
    const addr = buyerAddress
    if (!addr) {
      setFundNote('Connect a wallet to fund it.')
      return
    }
    setFunding(true)
    try {
      const res = await fetch('/api/onramp/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: addr, amount: usdAmount, redirectUrl: safeReturn }),
      })
      if (res.status === 503) {
        setFundNote('Bank funding is not configured yet.')
        return
      }
      const data = (await res.json()) as { url?: string; reason?: string }
      if (res.ok && data.url) {
        // Hand off to the provider's hosted checkout (a new tab keeps the cart).
        window.open(data.url, '_blank', 'noopener,noreferrer')
      } else {
        setFundNote(data.reason ?? 'Could not start bank funding. Please try again.')
      }
    } catch {
      setFundNote('Could not start bank funding. Please try again.')
    } finally {
      setFunding(false)
    }
  }, [buyerAddress, usdAmount, safeReturn])

  const handleOneTapDeposit = useCallback(async (): Promise<void> => {
    setFundNote(null)
    const addr = buyerAddress
    if (!addr) {
      setFundNote('Connect a wallet to fund it.')
      return
    }
    setFunding(true)
    try {
      const res = await runBlinkDeposit({ amount: usdAmount, address: addr as Address, chainId })
      if (!res.ok) {
        setFundNote(
          res.code === 'not_configured'
            ? 'One-tap deposit is not configured yet.'
            : 'One-tap deposit is unavailable right now.',
        )
      }
      // On success the USDC lands in the EOA; the buyer then taps Pay below.
    } catch {
      setFundNote('One-tap deposit is unavailable right now.')
    } finally {
      setFunding(false)
    }
  }, [buyerAddress, usdAmount, chainId])

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
    if (!walletClient) {
      setPayError('Connect a wallet to pay.')
      return
    }
    if (!merchant.active) {
      setPayError('This merchant is not currently accepting payments.')
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
        returnUrl={safeReturn}
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
        {/* ENSIP-19 verified merchant identity (off the money path): shows
            "Paying acme.eth ✓" ONLY when the payout address has a primary name
            that forward-resolves back to it; otherwise the truncated address.
            Never fabricates a name. */}
        <MerchantIdentity payout={merchant.payout} chainId={chainId} />
      </div>

      <div className="rounded-xl border border-border p-5">
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
        {/* ERC-7677 sponsored-gas badge (env-gated, fail-soft).
            Shown ONLY when a paymaster is configured AND it covers this chain
            (`isPaymasterActiveForChain`). A paymaster for chain A never shows on
            chain B — no false "free gas" claim (law #4 / truth-in-copy). When
            NEXT_PUBLIC_PAYMASTER_URL or NEXT_PUBLIC_PAYMASTER_CHAIN_ID are unset
            this is false and the badge is absent; the pay flow is unchanged. */}
        {gasSponsored ? (
          <div
            data-testid="gas-sponsored-badge"
            className="mt-1 flex items-center gap-1.5 rounded-md border border-green-200 bg-green-50 px-2 py-1"
          >
            <svg
              aria-hidden="true"
              className="h-3.5 w-3.5 flex-shrink-0 text-green-600"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <p className="text-xs font-medium text-green-700">
              Gas sponsored — you pay $0 in network fees.
            </p>
          </div>
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

      {/* Flow "pay in any token → USDC" OPTIONAL seam (default OFF, env-gated on
          NEXT_PUBLIC_FLOW_ENABLED + app id). Surfaced ONLY when configured. The
          swap step is a documented adapter/stub (lib/flow) — no aggregator SDK is
          wired yet — so this copy is TRUTHFUL (law #4): it announces the option
          and points the buyer to the picker/funding above to settle in USDC. It
          does NOT claim any token is swapped or settled, and it is OFF the money
          path (it never calls payToken with an unswapped token). */}
      {flowConfigured ? (
        <div
          data-testid="flow-any-token"
          data-flow="true"
          className="rounded-xl border border-dashed border-input bg-secondary p-4"
        >
          <p className="text-sm font-medium text-neutral-700">Pay in any token</p>
          <p className="mt-1 text-xs text-neutral-500">
            Coming soon — your token will be swapped to USDC at checkout. For now,
            pick an accepted token above or top up in USDC to pay.
          </p>
        </div>
      ) : null}

      {isConnected && buyerAddress && needsHuman && !humanVerified ? (
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
            signal={buyerAddress}
            onVerified={() => setHumanVerified(true)}
          />
        </div>
      ) : null}

      {isConnected && needsTier ? (
        // Buyer-tier gate (Super Verification): a precondition in front of pay,
        // off the money path. Shows the buyer's current rung; when it's below the
        // merchant's requirement, pay stays disabled and we point them to /verify.
        <div
          data-required-tier={requiredTier}
          data-tier-met={tierMet}
          className={`flex flex-col gap-2 rounded-xl border p-4 ${
            tierMet ? 'border-green-300 bg-green-50' : 'border-border bg-secondary'
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

      {isConnected ? (
        <FundButton
          showBank={bankConfigured}
          showOneTap={oneTapConfigured}
          onFundWithBank={() => void handleFundWithBank()}
          onOneTapDeposit={() => void handleOneTapDeposit()}
          busy={funding}
          note={fundNote}
        />
      ) : null}

      {isConnected ? (
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
          <BuyerConnectButton />
        </div>
      )}

      {payError ? <p className="text-sm text-red-600">{payError}</p> : null}

      <p className="flex items-center justify-center gap-1.5 border-t border-neutral-100 pt-4 text-center text-xs text-neutral-400">
        <span>Powered by</span>
        <BrandMark size={14} />
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
  const known: Record<string, string> = {
    Access0x1__MerchantInactive: 'This merchant is not currently accepting payments.',
    Access0x1__MerchantNotFound: 'This checkout link is not registered yet.',
    Access0x1__TokenNotAllowed: 'This token is not accepted for this payment.',
    Access0x1__Underpaid: 'The payment came in under the amount due — please try again.',
    Access0x1__InvalidPrice: 'The price feed returned an invalid value — please try again shortly.',
    OracleLib__StalePrice: 'The price feed is briefly stale — please try again in a moment.',
  }
  for (const [name, friendly] of Object.entries(known)) {
    if (message.includes(name)) return friendly
  }
  if (/insufficient/i.test(message)) return `Insufficient ${tokenSymbol} balance for this payment.`
  return 'Payment failed. Please try again.'
}
