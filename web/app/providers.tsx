'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createConfig, WagmiProvider } from 'wagmi'
import { http } from 'viem'
import { useState, type ReactNode } from 'react'
import { SUPPORTED_CHAINS } from '@/lib/chains'

/**
 * GLOBAL provider stack — wagmi + react-query ONLY. NO Dynamic.
 *
 * MAU = BUSINESSES (the core model). One Dynamic MAU must equal one BUSINESS, not
 * one customer; so the surface every visitor (including a paying customer on the
 * hosted checkout) gets is plain wagmi — never a Dynamic session. A shopper who
 * connects a wallet and pays is therefore NOT metered as an MAU, which is what
 * lets "1000 Dynamic MAU" mean "1000 businesses, unlimited customers".
 *
 * Dynamic is mounted ONLY around merchant surfaces (`/onboard`, `/dashboard`,
 * `/admin`, `/settings/*`) via {@link MerchantProviders}, which wraps those pages
 * in the full `DynamicContextProvider` stack with its own bridged wagmi config.
 * Merchant onboarding/auth therefore stays on Dynamic exactly as before; the
 * customer checkout does not.
 *
 * The wagmi config here drives the buyer checkout: EIP-6963 multi-injected
 * discovery is ON so every injected browser wallet (MetaMask, Rabby, Brave,
 * Frame, …) is surfaced via `useConnect`. WalletConnect can be layered on by
 * adding its connector here without touching the checkout components.
 */
export function Providers({ children }: { children: ReactNode }): ReactNode {
  // One QueryClient per mount (avoids sharing cache across requests in SSR).
  const [queryClient] = useState(() => new QueryClient())

  // The CUSTOMER wagmi config. EIP-6963 multi-injected-provider discovery ON
  // (wagmi default) so every injected browser wallet is surfaced through
  // `useConnect`, not just the first one.
  const [wagmiConfig] = useState(() =>
    createConfig({
      chains: SUPPORTED_CHAINS,
      multiInjectedProviderDiscovery: true,
      transports: Object.fromEntries(SUPPORTED_CHAINS.map((c) => [c.id, http()])),
    }),
  )

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
