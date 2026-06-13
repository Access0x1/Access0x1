/**
 * @file circleAppKit.ts — Arc rail: Circle App Kit Swap (Circle Stablecoin Service).
 *
 * Arc is our DEFAULT settlement chain and Uniswap has NOTHING on Arc, so Circle App Kit Swap
 * is Arc's same-chain payout rail (it ranks ABOVE the Uniswap legs precisely because Arc is the
 * default). App Kit is viem-native (`@circle-fin/adapter-viem-v2`); the merchant's
 * viem account/server-wallet signs — non-custodial, App Kit `customFee = 0` (the router
 * fee-split is the sole monetization, law #4).
 *
 * The App Kit SDK surface is captured behind the injectable {@link AppKitSwapSdk} seam so the
 * rail unit-tests offline against a mock. Honest fallback (CHAINS.md): if the USDC→payoutToken
 * pair has no routable Arc liquidity, App Kit's quote rejects and the worker degrades to direct
 * USDC (the merchant keeps settled USDC — law #5).
 *
 * @warn BOOTH-CONFIRM the App Kit Swap method names and that the USDC→Y pair routes on Arc.
 */

import type {
  PayoutSwapClient,
  RailExecution,
  RailQuote,
  SwapRequest,
} from '../types.js'

/** App Kit quote response (subset). */
export interface AppKitQuoteResponse {
  /** Expected output amount, atomic in the output token's decimals, as a string. */
  amountOut: string
  /** Opaque quote/route handle echoed back into `executeSwap`. */
  quoteHandle: string
}

/** App Kit swap-execution response (subset). */
export interface AppKitSwapResponse {
  /** The landed transaction hash. */
  transactionHash: string
}

/**
 * The Circle App Kit Swap surface this rail depends on. Injected so the rail is offline-testable;
 * at app boot the real `@circle-fin/...` App Kit (wired to the merchant's viem signer) is passed.
 */
export interface AppKitSwapSdk {
  /** Quote USDC→payoutToken on Arc. Rejects when the pair has no routable Arc liquidity. */
  getSwapQuote(input: {
    chainId: number
    fromToken: string
    toToken: string
    fromAmount: string
    account: string
  }): Promise<AppKitQuoteResponse>
  /** Execute the quoted swap (merchant-signed via the viem adapter). `customFee` is fixed 0. */
  executeSwap(input: {
    quoteHandle: string
    account: string
    minAmountOut: string
    customFee: 0
  }): Promise<AppKitSwapResponse>
}

/** Build the Arc Circle App Kit Swap rail client. */
export function createCircleAppKitClient(sdk: AppKitSwapSdk): PayoutSwapClient {
  return {
    rail: 'circle-app-kit',

    async quote(req: SwapRequest): Promise<RailQuote> {
      const q = await sdk.getSwapQuote({
        chainId: req.chainId,
        fromToken: req.usdc,
        toToken: req.payoutToken,
        fromAmount: req.amountUsdc.toString(),
        account: req.merchant,
      })
      if (!q.amountOut) throw new Error('Circle App Kit getSwapQuote returned no amountOut')
      return { amountOut: BigInt(q.amountOut), quoteHandle: q.quoteHandle } as RailQuote & {
        quoteHandle: string
      }
    },

    async execute(req: SwapRequest, quote: RailQuote): Promise<RailExecution> {
      const quoteHandle = (quote as RailQuote & { quoteHandle?: string }).quoteHandle
      if (!quoteHandle) throw new Error('Circle App Kit execute missing quoteHandle')
      const r = await sdk.executeSwap({
        quoteHandle,
        account: req.merchant,
        minAmountOut: req.minAmountOut.toString(),
        customFee: 0, // sole monetization is the router fee-split — no double-charge (law #4).
      })
      if (!r.transactionHash) throw new Error('Circle App Kit executeSwap returned no transactionHash')
      return { txHash: r.transactionHash, rail: 'circle-app-kit' }
    },
  }
}
