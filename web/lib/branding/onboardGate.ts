/**
 * onboardGate.ts — the connect-gate decision for the onboard shell.
 *
 * The onboard page branches on whether a merchant wallet is connected:
 *   - DISCONNECTED → render ONE hero connect-gate (a single headline + a single
 *     ConnectButton + the "what you'll build" line), NOT three empty card boxes
 *     each repeating a sign-in prompt.
 *   - CONNECTED → render the three configuration cards (branding, checkout-mode,
 *     verification).
 *
 * The decision is a pure predicate so it is unit-testable without rendering the
 * Dynamic-hooked component (the `canShowCasinoBadge` precedent). It is fail-soft:
 * `primaryWallet` is read inside the MerchantProviders subtree, so when Dynamic
 * is unconfigured the provider simply never yields a wallet and we stay on the
 * connect-gate — no hard-throw.
 */

/**
 * Should the onboard shell show the three configuration cards (vs the single
 * hero connect-gate)?
 *
 * @param hasWallet - truthy when a Dynamic primary wallet is connected.
 * @returns true to show the configuration cards; false for the connect-gate.
 */
export function showOnboardCards(hasWallet: unknown): boolean {
  return Boolean(hasWallet)
}
