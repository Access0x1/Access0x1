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
 * MERCHANT-only provider stack — the full Dynamic auth flow.
 *
 * MAU = BUSINESSES: Dynamic is mounted ONLY here, around the merchant surfaces
 * (`/onboard`, `/dashboard`, `/admin`, `/settings/*`). Each MERCHANT who connects
 * is one Dynamic MAU == one business. The global stack (app/providers.tsx) is
 * plain wagmi with NO Dynamic, so a paying CUSTOMER never opens a Dynamic session
 * and is never metered as an MAU.
 *
 * This is a SELF-CONTAINED stack (Dynamic → Wagmi → Query → DynamicWagmiConnector)
 * — the canonical Dynamic ordering with Dynamic as the outer provider. Its own
 * nested `WagmiProvider` shadows the global customer wagmi config for the merchant
 * subtree, so merchant components keep using Dynamic hooks (`useDynamicContext`,
 * `setShowAuthFlow`, `getWalletClient`) exactly as before. Per Dynamic's guidance,
 * `multiInjectedProviderDiscovery` is OFF on this bridged config — Dynamic runs
 * EIP-6963 discovery itself.
 *
 * Fail-soft: when `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` is unset (e.g. a build with
 * no env configured), Dynamic hard-throws on an empty `environmentId`, so we
 * render the merchant subtree on bare wagmi instead — pages still build and serve;
 * wallet connection simply stays disabled until the env id is set (warned in
 * dynamic.ts). This mirrors the previous global behavior.
 */
export function MerchantProviders({ children }: { children: ReactNode }): ReactNode {
  const [queryClient] = useState(() => new QueryClient())

  // The MERCHANT wagmi config, bridged to Dynamic. EIP-6963 discovery is OFF
  // here because Dynamic implements the multi-injected-provider protocol itself.
  const [wagmiConfig] = useState(() =>
    createConfig({
      chains: SUPPORTED_CHAINS,
      multiInjectedProviderDiscovery: false,
      transports: Object.fromEntries(SUPPORTED_CHAINS.map((c) => [c.id, http()])),
    }),
  )

  const settings = buildDynamicSettings()

  // Dynamic hard-throws when `environmentId` is empty. Fail soft: render the
  // merchant subtree on bare wagmi so pages still build; wallet connection stays
  // disabled until NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID is set (warned in dynamic.ts).
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
