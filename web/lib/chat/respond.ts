/**
 * respond.ts — turn a parsed {@link ChatIntent} into a chat reply. Transport- and
 * app-agnostic: all app knowledge (the checkout origin, the ENS parent, how a name
 * resolves to a checkout link) is INJECTED via {@link ChatReplyDeps}, so this is
 * pure and fully unit-testable, and the Telegram/WhatsApp routes wire the real deps.
 *
 * MODE (truth in copy): Phase 1 is LINK mode — the bot never holds a key. A `send`
 * yields our hosted checkout link (amount prefilled as a hint, and stated in the
 * text); the payment is signed in the sender's own wallet. Read commands that need
 * to know WHO is asking (balance/receipt) honestly point at the app until wallet
 * mode (Phase 3) binds a chat identity to a bounded MPC wallet.
 */

import type { ChatIntent } from './parse.js'

/** A recipient the bot could resolve to a payable checkout. */
export interface ResolvedRecipient {
  /** Human display for the reply (the ENS name or handle we resolved). */
  readonly display: string
  /** The hosted checkout URL the sender taps to pay (signs in their own wallet). */
  readonly checkoutUrl: string
}

/** Everything the reply builder needs from the app (all injected — keeps it pure). */
export interface ChatReplyDeps {
  /** Absolute app origin, e.g. `https://access0x1.example` (no trailing slash). */
  readonly origin: string
  /** The ENS parent claimed names live under, e.g. `access0x1.eth` (display only). */
  readonly parentName: string
  /**
   * Resolve a recipient token (a name / `.eth` / handle) to a payable checkout, or
   * null when there's no name found. NEVER guesses an address (law): unknown → null.
   */
  resolveRecipient(recipient: string): Promise<ResolvedRecipient | null>
}

/** Format a USD amount for chat ("$10", "$2.50"). */
function usd(amount: number): string {
  return `$${amount.toFixed(2).replace(/\.00$/, '')}`
}

/** Append an `amount` hint to a checkout URL without clobbering existing query. */
function withAmount(url: string, amountUsd: number): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}amount=${encodeURIComponent(String(amountUsd))}`
}

/** The command help text (also the reply to `help`/`start`/unknown). */
export function helpText(deps: ChatReplyDeps): string {
  return [
    'Access0x1 — pay by chat 💸',
    '',
    '• *send 10 to @maria* — get a pay link (you sign in your own wallet)',
    '• *pay 5 to maria.eth* — pay by ENS name',
    '• *name* — claim your own name to get paid',
    '• *balance* / *receipt* — check your wallet',
    '',
    `Every payment rides the full rail: a name, an on-chain receipt, zero custody. Claimed names live under \`${deps.parentName}\`.`,
  ].join('\n')
}

/**
 * Build the reply for one intent. Async because `send` resolves the recipient.
 * Never throws — a resolver error degrades to the honest "couldn't find that name".
 */
export async function buildChatReply(intent: ChatIntent, deps: ChatReplyDeps): Promise<string> {
  switch (intent.kind) {
    case 'help':
      return helpText(deps)

    case 'name':
      return [
        'Claim your name — it becomes your payment address for life.',
        `Set it up here: ${deps.origin}/onboard`,
        `You'll get \`yourname.${deps.parentName}\`, and people can just "send 10 to yourname".`,
      ].join('\n')

    case 'balance':
      return `Open ${deps.origin} and connect your wallet to see your balance. (Inline balances arrive with wallet mode.)`

    case 'receipt':
      return `Your receipts live at ${deps.origin}/dashboard — every payment is an on-chain receipt you can open in the explorer.`

    case 'send': {
      let resolved: ResolvedRecipient | null = null
      try {
        resolved = await deps.resolveRecipient(intent.recipient)
      } catch {
        resolved = null
      }
      if (!resolved) {
        return [
          `I couldn't find a name for "${intent.recipient}".`,
          `Ask them to claim one at ${deps.origin}/onboard, then try again.`,
        ].join('\n')
      }
      return [
        `Pay ${usd(intent.amountUsd)} to *${resolved.display}*:`,
        withAmount(resolved.checkoutUrl, intent.amountUsd),
        'You sign in your own wallet — Access0x1 never holds your funds.',
      ].join('\n')
    }

    case 'unknown':
    default:
      return helpText(deps)
  }
}
