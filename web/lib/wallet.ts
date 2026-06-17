import { createPublicClient, http, type Address, type PublicClient, type WalletClient } from 'viem'
import { isEthereumWallet } from '@dynamic-labs/ethereum'
import type { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { getChain, getRpcUrl } from './chains'

/**
 * The primary-wallet type, derived from Dynamic's own hook return so we never
 * import an unexported internal symbol. It is `Wallet | null`.
 */
export type DynamicWallet = ReturnType<typeof useDynamicContext>['primaryWallet']

/**
 * Get a viem `WalletClient` from a Dynamic primary wallet for signing.
 *
 * Goes through Dynamic's abstraction (`isEthereumWallet` guard +
 * `getWalletClient()`) so both the embedded wallet and EOA paths work — never
 * wagmi's `useConnect` directly (integration note in the spec).
 *
 * @throws if the wallet is not an EVM wallet or no client is available.
 */
export async function getWalletClient(wallet: DynamicWallet): Promise<WalletClient> {
  if (!wallet) throw new Error('Connect a wallet to continue')
  if (!isEthereumWallet(wallet)) {
    throw new Error('Only EVM wallets are supported — connect MetaMask, Coinbase Wallet, or any WalletConnect wallet.')
  }
  const client = await wallet.getWalletClient()
  if (!client) throw new Error('Could not obtain a wallet client')
  return client as WalletClient
}

/** The connected wallet's address, or null if not connected. */
export function getWalletAddress(wallet: DynamicWallet): Address | null {
  if (!wallet) return null
  return wallet.address as Address
}

/**
 * A read-only viem `PublicClient` for a given chain. Used on the client for
 * reads that do not need the wallet (e.g. reading the merchant record). Quotes
 * go through the server `/api/quote` route to avoid exposing an RPC key.
 */
export function getPublicClient(chainId: number): PublicClient {
  const chain = getChain(chainId)
  return createPublicClient({
    chain,
    transport: http(getRpcUrl(chainId)),
  }) as PublicClient
}
