/**
 * Local type shim for `@swype-org/deposit` — the one-tap deposit ("Fund without
 * leaving the app") SDK that sits ON TOP of the embedded wallet (Dynamic here) as
 * the funding layer.
 *
 * WHY THIS EXISTS
 * ----------------
 * The deposit SDK is a booth-installed package whose exact API surface is
 * confirmed at the booth against the live docs (https://docs.blink.cash). To keep
 * this unit's gate green and self-contained off a clean `main` — without pinning
 * a moving package — we declare ONLY the narrow surface this app consumes:
 * `requestDeposit`. Swap `tsconfig.json` `paths` (or just install the package) to
 * the real module once the version is pinned at the booth.
 *
 * ⚠️ BOOTH-CONFIRM the `requestDeposit` arg/return shape below against the live
 * SDK before the live demo. These shapes follow the documented one-tap deposit
 * call `requestDeposit({ amount, chainId, address, token })`.
 */
declare module '@swype-org/deposit' {
  /** Inputs to the one-tap deposit. The `address` is the wallet to fund. */
  export interface RequestDepositParams {
    /** Human deposit amount (e.g. "5.00"); the SDK quotes + collects it. */
    amount: string
    /** Destination chain id the deposited token lands on. */
    chainId: number
    /** Destination wallet address to fund (the buyer/agent EOA). */
    address: `0x${string}`
    /** Token symbol or address to deposit (e.g. "USDC"). */
    token: string
  }

  /** Result of a settled one-tap deposit. */
  export interface RequestDepositResult {
    /** Whether the deposit was completed. */
    readonly status: 'completed' | 'pending' | 'cancelled' | (string & {})
    /** Funding tx hash, when the deposit settled on-chain. */
    readonly txHash?: `0x${string}`
  }

  /**
   * Open the one-tap deposit flow for the connected wallet. The SDK handles
   * address/network selection internally — the user never copies an address or
   * switches networks. Pass the embedded-wallet primary wallet's address.
   */
  export function requestDeposit(params: RequestDepositParams): Promise<RequestDepositResult>
}
