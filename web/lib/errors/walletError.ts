/**
 * @file walletError.ts — turn a thrown viem/wallet error into a line a merchant can act on.
 *
 * The default in a React form is `setError(err.message)`, which puts a viem error — often
 * several lines of ABI dump, request body and docs URL — straight into the UI. On the
 * registration form that lands at the single worst moment: someone has typed their business
 * name and price, pressed the button, and the reward is a wall of hex. The two most common
 * causes are also the two most recoverable (they rejected the prompt themselves, or the
 * wallet has no gas), and neither is legible in the raw text.
 *
 * This is the SHARED generic layer. Contract-specific revert names stay with the module that
 * owns them and are passed in as `knownReverts` — see `lib/admin/provenanceRegistry.ts`,
 * whose registry errors were the original home of this logic.
 *
 * Never returns a stack trace, and never an empty string.
 */

/** The last-resort line, used when an error carries no usable text at all. */
const FALLBACK = 'The transaction failed. Please try again.'

/** Read `.message` off an unknown throw without assuming it is an Error. */
function messageOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return String(err)
}

/**
 * Convert a thrown wallet/RPC error into one human sentence.
 *
 * Resolution order: a caller-supplied custom revert (matched by name), then the generic
 * wallet conditions, then viem's own `shortMessage`, then the first line of the raw message.
 * Later steps are progressively less friendly but never leak a stack trace.
 *
 * @param err The value thrown by a viem/wallet call.
 * @param knownReverts Optional map of Solidity custom-error name → human sentence.
 * @returns A single sentence safe to render in the UI.
 */
export function humanizeWalletError(
  err: unknown,
  knownReverts: Readonly<Record<string, string>> = {},
): string {
  const message = messageOf(err)

  for (const [name, friendly] of Object.entries(knownReverts)) {
    if (message.includes(name)) return friendly
  }
  if (/User rejected|rejected the request|denied transaction|User denied/i.test(message)) {
    return 'You rejected the request in your wallet.'
  }
  // The gas cliff. Worth its own line because the fix is external to the app (go get
  // testnet funds) and nothing in the raw error says so.
  if (/insufficient funds/i.test(message)) {
    return 'Not enough gas in this wallet to send the transaction — top it up from a testnet faucet and try again.'
  }
  if (/nonce too low/i.test(message)) {
    return 'That transaction was already sent. Refresh the page before trying again.'
  }
  if (/replacement transaction underpriced|already known/i.test(message)) {
    return 'A transaction from this wallet is still pending — wait for it to confirm, then retry.'
  }
  if (/chain mismatch|does not match the target chain|chain id/i.test(message)) {
    return 'Your wallet is on a different network — switch networks and try again.'
  }
  // viem attaches a concise `shortMessage`; prefer it over the full dump.
  if (typeof err === 'object' && err !== null && 'shortMessage' in err) {
    const short = String((err as { shortMessage: unknown }).shortMessage).trim()
    if (short) return short
  }
  return message.split('\n')[0]?.trim() || FALLBACK
}
