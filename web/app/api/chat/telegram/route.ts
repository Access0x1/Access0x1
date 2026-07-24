/**
 * /api/chat/telegram — the Telegram Bot API webhook (chat payments, Phase 1).
 *
 * Env-gated + fail-soft like every seam: no `TELEGRAM_BOT_TOKEN` ⇒ GET reports
 * `{ configured:false }` and POST is a 503 `not_configured` no-op. The bot is a
 * FRONT DOOR only — it parses a message (lib/chat/parse), builds a reply
 * (lib/chat/respond), and sends it back via Telegram; the actual payment settles
 * in the sender's own wallet through our hosted checkout. Zero custody, zero money
 * logic here, and a webhook failure can never block or lose a payment (off the
 * money path).
 *
 * Security: when `TELEGRAM_WEBHOOK_SECRET` is set we require Telegram's
 * `X-Telegram-Bot-Api-Secret-Token` header to match (Telegram sends it when the
 * webhook was registered with a secret) — so only Telegram can drive this route.
 *
 *   GET  /api/chat/telegram  → { configured }
 *   POST /api/chat/telegram  → 200 (always, once configured; replies out-of-band)
 */

import { parseChatCommand } from '@/lib/chat/parse'
import { buildChatReply, type ChatReplyDeps, type ResolvedRecipient } from '@/lib/chat/respond'
import { checkoutOrigin } from '@/lib/branding/checkoutHost'
import { resolveENS } from '@/lib/ens'
import { getDefaultChainId } from '@/lib/chains'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** The ENS parent claimed names live under (display only). */
function chatParent(): string {
  return (process.env.CHAT_PAY_PARENT ?? 'access0x1.eth').trim() || 'access0x1.eth'
}

/**
 * The real recipient resolver: confirm the name resolves on-chain (so we never
 * hand out a link for a name that doesn't exist — law: never guess an address),
 * then build the hosted checkout link keyed by the name. Unknown / unresolvable
 * ⇒ null, which the reply layer turns into an honest "no name found".
 */
async function resolveRecipient(recipient: string): Promise<ResolvedRecipient | null> {
  const origin = checkoutOrigin()
  // A dotted ENS-shaped name we can verify on-chain; a bare label maps to a claimed
  // subname under the parent. Verify the ENS-shaped ones; bare labels resolve to the
  // subname checkout slug directly (the checkout page validates the slug itself).
  const isEnsShaped = recipient.includes('.')
  if (isEnsShaped) {
    try {
      await resolveENS(recipient, getDefaultChainId())
    } catch {
      return null // does not resolve → no name found (never a guessed address)
    }
    return { display: recipient, checkoutUrl: `${origin}/c/${encodeURIComponent(recipient)}` }
  }
  // Bare label → its claimed subname is the display + the checkout slug.
  const display = `${recipient}.${chatParent()}`
  return { display, checkoutUrl: `${origin}/c/${encodeURIComponent(recipient)}` }
}

function deps(): ChatReplyDeps {
  return { origin: checkoutOrigin(), parentName: chatParent(), resolveRecipient }
}

/** Post a reply back to the chat via the Telegram Bot API (best-effort). */
async function sendTelegramMessage(token: string, chatId: number | string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
  } catch {
    // Send failure is off the money path — swallow (the payment link is idempotent).
  }
}

/** Capability probe — reveals only whether the bot is configured (never the token). */
export async function GET(): Promise<Response> {
  return json({ configured: Boolean((process.env.TELEGRAM_BOT_TOKEN ?? '').trim()) })
}

export async function POST(request: Request): Promise<Response> {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim()
  if (!token) {
    return json({ error: 'Telegram bot is not configured.', code: 'not_configured' }, 503)
  }

  // Optional shared-secret check: only Telegram (which echoes the secret we set)
  // may drive the webhook. When unset, we accept (dev/booth), mirroring fail-soft.
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET ?? '').trim()
  if (secret && request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return json({ error: 'unauthorized', code: 'bad_secret' }, 401)
  }

  let update: { message?: { chat?: { id?: number | string }; text?: unknown } }
  try {
    update = (await request.json()) as typeof update
  } catch {
    return json({ ok: true }) // malformed update — ack so Telegram stops retrying
  }

  const chatId = update.message?.chat?.id
  const text = typeof update.message?.text === 'string' ? update.message.text : ''
  if (chatId === undefined || !text) {
    return json({ ok: true }) // nothing to act on (non-text update) — ack
  }

  const intent = parseChatCommand(text)
  const reply = await buildChatReply(intent, deps())
  await sendTelegramMessage(token, chatId, reply)

  // Always 200 so Telegram doesn't retry; the reply already went out-of-band.
  return json({ ok: true })
}
