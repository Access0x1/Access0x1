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
    // Dynamic isn't configured (no NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID). Render a graceful
    // notice INSTEAD of the merchant children — they call Dynamic hooks (useDynamicContext)
    // that hard-throw without the provider, which white-screens the whole page. The
    // customer/checkout surfaces (app/providers.tsx, no Dynamic) are unaffected. A self-hoster
    // sets the env id to light up the merchant/wallet flow.
    return (
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <DynamicNotConfiguredNotice />
        </QueryClientProvider>
      </WagmiProvider>
    )
  }

  return (
    // theme="dark" renders the Dynamic auth modal on the dark chassis (no white
    // flash over the dark app); the exact surface/border/brand tuning lives in
    // settings.cssOverrides (lib/dynamic.ts). `theme` is a top-level provider prop
    // (sibling of `settings`), not a settings field.
    <DynamicContextProvider theme="dark" settings={settings}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <DynamicWagmiConnector>{children}</DynamicWagmiConnector>
        </QueryClientProvider>
      </WagmiProvider>
    </DynamicContextProvider>
  )
}

/**
 * Fail-soft fallback shown on merchant surfaces when Dynamic is unconfigured.
 * Renders in place of the merchant children so their Dynamic hooks never run
 * (which would otherwise throw "Hook must be used within <DynamicContextProvider>").
 */
function DynamicNotConfiguredNotice(): ReactNode {
  return (
    <main style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', padding: '2rem', textAlign: 'center' }}>
      <div style={{ maxWidth: 520 }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.75rem' }}>
          Wallet sign-in is not configured
        </h1>
        <p style={{ opacity: 0.7, lineHeight: 1.6 }}>
          The merchant flow uses Dynamic for wallet auth. Set{' '}
          <code>NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID</code> for this deployment to enable
          onboarding. Payment and checkout surfaces work without it.
        </p>
      </div>
    </main>
  )
}
