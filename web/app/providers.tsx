'use client'

import { DynamicContextProvider } from '@dynamic-labs/sdk-react-core'
import { DynamicWagmiConnector } from '@dynamic-labs/wagmi-connector'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createConfig, WagmiProvider } from 'wagmi'
import { http } from 'viem'
import { useState, type ReactNode } from 'react'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { buildDynamicSettings } from '@/lib/dynamic'

/**
 * Client-side provider stack:
 *   DynamicContextProvider -> WagmiProvider -> QueryClientProvider
 *
 * All wallet connection + signing goes through Dynamic; wagmi is bridged in via
 * `@dynamic-labs/wagmi-connector` so any wagmi-based hook also works, but the
 * checkout/onboard flows use the direct viem WalletClient path (see lib/wallet.ts).
 */
export function Providers({ children }: { children: ReactNode }): ReactNode {
  // One QueryClient per mount (avoids sharing cache across requests in SSR).
  const [queryClient] = useState(() => new QueryClient())

  // wagmi config built from the same supported-chain list Dynamic advertises.
  const [wagmiConfig] = useState(() =>
    createConfig({
      chains: SUPPORTED_CHAINS,
      multiInjectedProviderDiscovery: false,
      transports: Object.fromEntries(SUPPORTED_CHAINS.map((c) => [c.id, http()])),
    }),
  )

  const settings = buildDynamicSettings()

  // Dynamic hard-throws when `environmentId` is empty (e.g. during a build with
  // no env configured). Fail soft: render the app without the wallet provider so
  // pages still build and serve — wallet connection simply stays disabled until
  // NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID is set. The warning is logged in dynamic.ts.
  if (!settings.environmentId) {
    return (
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    )
  }

  return (
    <DynamicContextProvider settings={settings}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <DynamicWagmiConnector>{children}</DynamicWagmiConnector>
        </QueryClientProvider>
      </WagmiProvider>
    </DynamicContextProvider>
  )
}
