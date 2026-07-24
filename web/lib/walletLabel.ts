/**
 * @file walletLabel.ts — a LOCAL display name for a connected wallet.
 *
 * Problem it solves: an external wallet (e.g. MetaMask) NEVER shares its account
 * nickname with a site — the only names a dapp can show are on-chain ones. So a
 * user who connects sees a bare truncated address until they hold a verified ENS
 * primary name. This gives them a name immediately: when they register a
 * business we label their wallet with the business name (and the label is theirs
 * to change), stored in localStorage on THEIR device only.
 *
 * Honesty rules:
 *  - This is a PLAIN LABEL, never an identity claim: the UI must not render it
 *    with any "verified" affordance. Verified identity remains exclusively the
 *    ENSIP-19 forward==reverse primary-name path (`usePrimaryEnsName`).
 *  - Local-only: nothing is sent to a server; clearing site data clears it.
 *  - SSR/failure-safe: every call no-ops (returns null) when localStorage is
 *    unavailable — never a crash (law #1).
 */

const PREFIX = 'ax1.walletLabel.'

/** Normalize an address into the storage key (case-insensitive identity). */
function keyFor(address: string): string {
  return `${PREFIX}${address.trim().toLowerCase()}`
}

/** Read the local label for an address, or null (unset / SSR / storage blocked). */
export function getWalletLabel(address: string | undefined | null): string | null {
  if (!address) return null
  try {
    const v = window.localStorage.getItem(keyFor(address))
    return v && v.trim().length > 0 ? v : null
  } catch {
    return null
  }
}

/** Set (or with '' clear) the local label for an address. Silently no-ops on failure. */
export function setWalletLabel(address: string | undefined | null, label: string): void {
  if (!address) return
  try {
    const trimmed = label.trim()
    if (trimmed.length === 0) window.localStorage.removeItem(keyFor(address))
    else window.localStorage.setItem(keyFor(address), trimmed.slice(0, 64))
  } catch {
    /* storage unavailable — the label is a nicety, never an error */
  }
}
