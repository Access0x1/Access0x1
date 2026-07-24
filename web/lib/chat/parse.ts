/**
 * parse.ts — the shared command brain for chat payments (Telegram now, WhatsApp
 * next; both transports reuse THIS). Pure text → structured intent: no network,
 * no env, no money. The transport layer resolves the intent into a reply
 * (lib/chat/respond.ts) and the ACTUAL payment always settles in the sender's own
 * wallet via our hosted checkout — the bot owns zero money logic (front door only).
 *
 * Supported commands (case-insensitive, forgiving of extra whitespace):
 *   send 10 to @maria        → { kind:'send', amountUsd:10, recipient:'maria' }
 *   pay $5 to maria.eth       → { kind:'send', amountUsd:5,  recipient:'maria.eth' }
 *   transfer 2.50 usdc to bob → { kind:'send', amountUsd:2.5, recipient:'bob' }
 *   balance                   → { kind:'balance' }
 *   receipt                   → { kind:'receipt' }
 *   name / claim              → { kind:'name' }
 *   help / start              → { kind:'help' }
 *   (anything else)           → { kind:'unknown', text }
 */

/** A parsed chat command. `send` carries the amount + raw recipient token. */
export type ChatIntent =
  | { kind: 'send'; amountUsd: number; recipient: string }
  | { kind: 'balance' }
  | { kind: 'receipt' }
  | { kind: 'name' }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string }

/** The verbs that mean "move money" (all map to a link-signed send). */
const SEND_VERBS = ['send', 'pay', 'transfer'] as const

/** Max USD a single chat command may name — a sanity clamp, not a spend policy. */
const MAX_AMOUNT_USD = 1_000_000

/**
 * Parse one chat message into a {@link ChatIntent}. Never throws; anything it
 * can't confidently read becomes `unknown` so the reply layer can show help.
 *
 * @param raw the message text (a Telegram/WhatsApp message body).
 */
export function parseChatCommand(raw: string): ChatIntent {
  const text = (raw ?? '').trim()
  if (!text) return { kind: 'unknown', text: '' }

  // Strip a leading slash-command form ("/send 10 to x", "/start") — Telegram style.
  const normalized = text.replace(/^\/+/, '').trim()
  const lower = normalized.toLowerCase()
  const firstWord = lower.split(/\s+/)[0]

  if (firstWord === 'help' || firstWord === 'start') return { kind: 'help' }
  if (firstWord === 'balance') return { kind: 'balance' }
  if (firstWord === 'receipt' || firstWord === 'receipts') return { kind: 'receipt' }
  if (firstWord === 'name' || firstWord === 'claim') return { kind: 'name' }

  if ((SEND_VERBS as readonly string[]).includes(firstWord)) {
    const send = parseSend(normalized)
    if (send) return send
  }

  return { kind: 'unknown', text }
}

/**
 * Parse a send/pay/transfer command. Grammar (tolerant):
 *   <verb> [$]<amount> [usd|usdc|dollars] [to] <recipient>
 * The amount is the first number (with optional `$` and up to 2 decimals); the
 * recipient is the last whitespace token, `@handle` / `name.eth` / bare label.
 * Returns null when either piece is missing/invalid (→ caller yields help).
 */
function parseSend(text: string): Extract<ChatIntent, { kind: 'send' }> | null {
  // Amount: first "$?<digits>[.<digits>]" occurrence.
  const amountMatch = text.match(/\$?\s*(\d+(?:\.\d{1,2})?)/)
  if (!amountMatch) return null
  const amountUsd = Number(amountMatch[1])
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > MAX_AMOUNT_USD) return null

  // Recipient: the last token, minus a trailing currency word if that's all that's left.
  const tokens = text.split(/\s+/).filter(Boolean)
  const last = tokens[tokens.length - 1]
  if (!last) return null
  const recipient = normalizeRecipient(last)
  // A recipient that is itself the amount/currency word means none was given.
  if (!recipient || /^\$?\d/.test(recipient) || isCurrencyWord(recipient)) return null

  return { kind: 'send', amountUsd, recipient }
}

/** A trailing "usd/usdc/dollars" is a denomination, not a recipient. */
function isCurrencyWord(s: string): boolean {
  return ['usd', 'usdc', 'dollar', 'dollars', 'to'].includes(s.toLowerCase())
}

/**
 * Normalize a recipient token: drop a leading `@`, lowercase, trim punctuation.
 * Keeps a `.eth` (or other dotted ENS) intact. Returns '' for an empty result.
 */
export function normalizeRecipient(token: string): string {
  return token
    .trim()
    .replace(/^@/, '')
    .replace(/[.,!?;:]+$/, '')
    .toLowerCase()
}
