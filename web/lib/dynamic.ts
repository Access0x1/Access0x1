import { EthereumWalletConnectors } from '@dynamic-labs/ethereum'
import { SortWallets, type DynamicContextProps } from '@dynamic-labs/sdk-react-core'
import { SUPPORTED_CHAINS } from './chains'

/**
 * Build the `DynamicContextProvider` settings.
 *
 * - `environmentId` comes from `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` (never
 *   hardcoded — guardrail #5 for the *Dynamic* env id, mirroring the address rule).
 * - `walletConnectors` is the EVM connector set (embedded wallet + EOA paths).
 * - `overrides.evmNetworks` maps each supported chain into Dynamic's `EvmNetwork`
 *   shape so the wallet can switch between Arc / Base Sepolia / zkSync Sepolia.
 *
 * ALL wallet connection + signing goes through Dynamic (no RainbowKit/ConnectKit).
 */
export function buildDynamicSettings(): DynamicContextProps['settings'] {
  const environmentId = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID
  if (!environmentId) {
    // Surface loudly in dev/build logs rather than silently mounting an unauthed provider.
    // eslint-disable-next-line no-console
    console.warn(
      'NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID is not set — wallet connection will not work.',
    )
  }

  return {
    environmentId: environmentId ?? '',
    walletConnectors: [EthereumWalletConnectors],
    // Pure wallet connect: skip the email/social + ownership-signing step. The payment tx itself is
    // the proof of ownership, so the modal opens as a clean OpenSea-style wallet picker, not a sign-in.
    initialAuthenticationMode: 'connect-only',
    // Show EVERY wallet the Dynamic dashboard enables (plus any EIP-6963 browser extension), but float
    // the popular ones to the top — the rest stay one scroll away. SortWallets REORDERS, never hides.
    walletsFilter: SortWallets([
      'metamaskevm',
      'coinbasewallet',
      'walletconnect',
      'rainbowwallet',
      'trustwallet',
      'phantomevm',
      'okxwallet',
      'rabbywallet',
    ]),
    // Badge the top three "Popular" — OpenSea's popular row.
    recommendedWallets: [
      { walletKey: 'metamaskevm', label: 'Popular' },
      { walletKey: 'coinbasewallet', label: 'Popular' },
      { walletKey: 'walletconnect', label: 'Popular' },
    ],
    // EOA/WalletConnect sessions prefer our settlement chains first.
    walletConnectPreferredChains: SUPPORTED_CHAINS.map((c) => `eip155:${c.id}` as `eip155:${number}`),
    // Theme the modal to the Access0x1 rail (cyan): inherits the app's --ax1-rail token through the
    // shadow DOM, with a hex fallback. A merchant's own brandColor still themes their checkout page.
    cssOverrides:
      '.dynamic-shadow-dom { --dynamic-brand-primary-color: var(--ax1-rail, #22d3ee); --dynamic-border-radius: 16px; }',
    overrides: {
      // Advertise every supported chain so the wallet can switch between them. Whether a chain can
      // actually be paid on is enforced at checkout (getRouterAddress) — never by hiding it here.
      evmNetworks: SUPPORTED_CHAINS.map((chain) => ({
        blockExplorerUrls: chain.blockExplorers?.default.url ? [chain.blockExplorers.default.url] : [],
        chainId: chain.id,
        chainName: chain.name,
        iconUrls: [],
        name: chain.name,
        nativeCurrency: {
          decimals: chain.nativeCurrency.decimals,
          name: chain.nativeCurrency.name,
          symbol: chain.nativeCurrency.symbol,
        },
        networkId: chain.id,
        rpcUrls: [...chain.rpcUrls.default.http],
        vanityName: chain.name,
      })),
    },
  }
}
