import { EthereumWalletConnectors } from '@dynamic-labs/ethereum'
import type { DynamicContextProps } from '@dynamic-labs/sdk-react-core'
import { SUPPORTED_CHAINS, getRouterAddress } from './chains'

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
    overrides: {
      evmNetworks: SUPPORTED_CHAINS.map((chain) => {
        // A router address is required per chain; only advertise chains we can pay on.
        let blockExplorer = chain.blockExplorers?.default.url
        // Tolerate a missing router config at build time (env may be unset locally);
        // the checkout page enforces it at call time.
        try {
          getRouterAddress(chain.id)
        } catch {
          blockExplorer = chain.blockExplorers?.default.url
        }
        return {
          blockExplorerUrls: blockExplorer ? [blockExplorer] : [],
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
        }
      }),
    },
  }
}
