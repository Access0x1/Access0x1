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
/**
 * Shown in place of the merchant subtree when Dynamic has no environment id.
 *
 * It cannot render the children — they call `useDynamicContext`, which hard-throws without
 * the provider — so this page IS the fallback, and a fallback that only says "not
 * configured" is a dead end. Two audiences hit it and both need somewhere to go:
 *
 *   - an OPERATOR, who needs the exact command, not just the variable name (this repo's
 *     env doctor never prints a missing var without printing how to fill it);
 *   - a VISITOR — a judge, a customer — who cannot fix it at all, and for whom the honest
 *     answer is that most of the product does not need a wallet and is one click away.
 *
 * The links below are all wallet-free surfaces, verified as such: `/deployments` reads live
 * `getCode` from each chain's public RPC, `/simulate` is pure arithmetic, `/ask` degrades on
 * its own probe, and the landing page is server-rendered.
 */
function DynamicNotConfiguredNotice(): ReactNode {
  const stillWorks: { href: string; label: string; blurb: string }[] = [
    {
      href: '/deployments',
      label: 'Live deployments',
      blurb: 'reads the deployed bytecode on every chain and diffs it against this build',
    },
    { href: '/simulate', label: 'Cost simulator', blurb: 'what a payment costs, on-chain' },
    { href: '/ask', label: 'Ask how it works', blurb: 'answers from the docs in this repo' },
    { href: '/', label: 'Start page', blurb: 'what this is and who it is for' },
  ]
  return (
    <main className="mx-auto grid min-h-[60vh] max-w-xl place-items-center px-6 py-12">
      <div>
        <h1 className="mb-3 text-xl font-semibold">Sign-in is not configured on this deployment</h1>
        <p className="text-sm leading-relaxed opacity-70">
          The merchant flow signs in through Dynamic, and this deployment has no{' '}
          <code>NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID</code>. Nothing is broken — that seam is
          simply dormant, and only the merchant surfaces need it.
        </p>
        <p className="mt-3 text-sm leading-relaxed opacity-70">
          Running this yourself? <code>npm run env:set -- dynamic</code> writes it to the right
          file, and <code>npm run env:doctor</code> lists whatever else is still missing.
        </p>

        <p className="mt-6 text-sm font-medium">Everything here works without signing in:</p>
        <ul className="mt-2 space-y-2 text-sm">
          {stillWorks.map(({ href, label, blurb }) => (
            <li key={href}>
              <a className="text-rail underline-offset-2 hover:underline" href={href}>
                {label}
              </a>
              <span className="opacity-60"> — {blurb}</span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
