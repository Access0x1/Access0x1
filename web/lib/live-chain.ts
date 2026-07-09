'use client'

/**
 * live-chain.ts — the LIVE-chain layer for merchant surfaces.
 *
 * THE DEFECT THIS FIXES: /onboard and /dashboard used to resolve the router
 * from the build-time default chain (`getDefaultChainId()`), while the actual
 * write (`registerMerchant`) submits on the WALLET'S current chain
 * (`chain: walletClient.chain`). A merchant whose wallet sat on a different
 * network would sign a transaction against the wrong-chain router address with
 * no warning. Everything here derives from the wallet's LIVE chain instead, so
 * the address a surface shows and the chain a write lands on can never diverge.
 *
 * HOW IT STAYS LIVE: `useLiveChain` reads wagmi's `useAccount()` /
 * `useChainId()`. On merchant surfaces those run inside the MerchantProviders
 * wagmi context, which `DynamicWagmiConnector` keeps in sync with the Dynamic
 * primary wallet — the underlying EIP-1193 `chainChanged` / `accountsChanged`
 * events update the wagmi store, and every subscribed hook re-renders. No
 * manual listeners, no refresh.
 *
 * FAIL-SOFT (law #4 — never a wrong-chain address): an unsupported live chain
 * resolves to `{ isSupported: false, routerAddress: null }`. In particular, a
 * chain the mirror is deployed to but that is NOT one of the app's
 * SUPPORTED_CHAINS still resolves null — we never hand a surface an address on
 * a chain the app can't otherwise handle.
 */

import { useMemo } from 'react'
import type { Address, Chain, WalletClient } from 'viem'
import { useAccount, useChainId } from 'wagmi'
import { SUPPORTED_CHAINS, getRouterAddress, getUsdcAddress } from './chains'

/** What the merchant surfaces know about the wallet's live chain. */
export interface LiveChain {
  /** The live chain id (the wallet's when connected, else the app's current
   *  wagmi chain), or null when nothing is known. */
  chainId: number | null
  /** The matching SUPPORTED_CHAINS object, or null when the id is not one of
   *  the app's chains (an unknown/unsupported network). */
  chain: Chain | null
  /** True only when the live chain is a supported app chain AND a router
   *  address resolves on it — i.e. a merchant write is possible here. */
  isSupported: boolean
  /** The router on the LIVE chain, or null (never a wrong-chain address). */
  routerAddress: Address | null
  /** The USDC on the LIVE chain, or null when unknown (display-side callers
   *  fall back gracefully; the money path reads decimals on-chain anyway). */
  usdcAddress: Address | null
  /** True when a wallet is connected through the wagmi context. */
  isConnected: boolean
}

/** The nothing-known state (no wallet, no chain). */
const EMPTY: LiveChain = {
  chainId: null,
  chain: null,
  isSupported: false,
  routerAddress: null,
  usdcAddress: null,
  isConnected: false,
}

/** Is this chain a testnet? Read straight off the viem chain object's own
 *  `testnet` flag (every SUPPORTED_CHAINS entry carries it) — never a second
 *  hand-maintained list that could drift. */
export function isTestnetChain(chain: Chain): boolean {
  return chain.testnet === true
}

/**
 * Resolve everything the merchant surfaces need from a LIVE chain id. Pure and
 * unit-testable — the hook below is a thin wagmi binding over this.
 *
 * Order matters: membership in SUPPORTED_CHAINS is checked FIRST, so a chain
 * the app doesn't support NEVER yields a router/USDC address, even where the
 * CREATE3 mirror would technically resolve one (fail-soft, never wrong-chain).
 * A supported chain with no resolvable router (e.g. a checkout-only chain with
 * no mirror and no env override) resolves `isSupported: false` too — a
 * merchant write there would fail loud, so the surface must not offer it.
 */
export function resolveLiveChain(chainId: number | null | undefined, isConnected = false): LiveChain {
  if (chainId === null || chainId === undefined) return { ...EMPTY, isConnected }

  const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId) ?? null
  if (!chain) {
    return { chainId, chain: null, isSupported: false, routerAddress: null, usdcAddress: null, isConnected }
  }

  // getRouterAddress / getUsdcAddress throw on a missing config (their loud
  // money-path contract); here we soften to null so a DISPLAY surface can say
  // "not on this network" instead of crashing.
  let routerAddress: Address | null = null
  try {
    routerAddress = getRouterAddress(chainId)
  } catch {
    routerAddress = null
  }
  let usdcAddress: Address | null = null
  try {
    usdcAddress = getUsdcAddress(chainId)
  } catch {
    usdcAddress = null
  }

  return { chainId, chain, isSupported: routerAddress !== null, routerAddress, usdcAddress, isConnected }
}

/**
 * The chains a merchant write can actually land on RIGHT NOW: supported app
 * chains where a router resolves. These are the switch targets NetworkBadge
 * offers when the wallet sits on an unsupported network.
 */
export function writableChains(): Chain[] {
  return SUPPORTED_CHAINS.filter((c) => resolveLiveChain(c.id).isSupported)
}

/**
 * useLiveChain — the wallet's LIVE chain, resolved for merchant surfaces.
 *
 * Sources, in order:
 *   1. `useAccount().chainId` — the CONNECTED wallet's actual chain. wagmi
 *      reports it even when the chain is outside the config (that's exactly
 *      the case we must catch), and re-renders on chainChanged AND
 *      accountsChanged via the Dynamic wagmi connector.
 *   2. `useChainId()` — the wagmi config's current chain, as the disconnected
 *      fallback so displays have something honest to show pre-connect.
 *
 * Must be called inside the MerchantProviders wagmi context.
 */
export function useLiveChain(): LiveChain {
  const { chainId: walletChainId, isConnected } = useAccount()
  const configChainId = useChainId()
  const liveChainId = walletChainId ?? configChainId
  return useMemo(() => resolveLiveChain(liveChainId, isConnected), [liveChainId, isConnected])
}

/**
 * ensureChain — the generalized AdminPanel `prepareWallet` (its lines 91-102):
 * make sure the wallet is ON `targetChainId` before any write, switching it
 * (the wallet's own switch prompt) when it isn't, and THROWING when it can't
 * land there — never letting a write proceed on the wrong chain.
 *
 * After a switch we re-read the chain from the transport (`eth_chainId`, the
 * live truth — `walletClient.chain` is a static snapshot from client creation)
 * and refuse to return success unless the wallet really moved.
 *
 * @returns true when a switch happened (callers that pass
 *   `chain: walletClient.chain` to a write should re-derive the client so its
 *   snapshot matches the new chain), false when the wallet was already there.
 * @throws when the wallet rejects the switch or ends up on a different chain.
 */
export async function ensureChain(walletClient: WalletClient, targetChainId: number): Promise<boolean> {
  const current = walletClient.chain?.id ?? (await walletClient.getChainId())
  if (current === targetChainId) return false

  // Prompts the wallet's own switch UI; rejection propagates to the caller.
  await walletClient.switchChain({ id: targetChainId })

  // Verify against the transport, not the stale client snapshot.
  const after = await walletClient.getChainId()
  if (after !== targetChainId) {
    throw new Error(
      `Wallet did not switch to chain ${targetChainId} (still on ${after}) — switch networks in your wallet and try again.`,
    )
  }
  return true
}
