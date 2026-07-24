/**
 * @file respond.test.ts — the chat reply builder (pure, injected deps).
 * Proves: a resolvable send yields the checkout link + amount; an unresolvable
 * recipient degrades honestly (never a guessed address); read/name/help copy.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildChatReply, type ChatReplyDeps } from '../respond'
import { parseChatCommand } from '../parse'

function deps(over?: Partial<ChatReplyDeps>): ChatReplyDeps {
  return {
    origin: 'https://pay.example',
    parentName: 'access0x1.eth',
    resolveRecipient: vi.fn(async (r: string) =>
      r === 'maria'
        ? { display: 'maria.access0x1.eth', checkoutUrl: 'https://pay.example/c/maria' }
        : null,
    ),
    ...over,
  }
}

describe('buildChatReply — send', () => {
  it('resolvable recipient → checkout link with the amount hint + stated amount', async () => {
    const reply = await buildChatReply(parseChatCommand('send 10 to @maria'), deps())
    expect(reply).toContain('$10')
    expect(reply).toContain('maria.access0x1.eth')
    expect(reply).toContain('https://pay.example/c/maria?amount=10')
    expect(reply).toContain('own wallet')
  })

  it('formats cents ($2.50)', async () => {
    const reply = await buildChatReply(parseChatCommand('pay 2.50 to maria'), deps())
    expect(reply).toContain('$2.50')
  })

  it('unresolvable recipient → honest "no name found", never a link', async () => {
    const reply = await buildChatReply(parseChatCommand('send 5 to ghost'), deps())
    expect(reply.toLowerCase()).toContain("couldn't find")
    expect(reply).toContain('/onboard')
    expect(reply).not.toContain('/c/')
  })

  it('a resolver that throws degrades to the honest fallback (never throws)', async () => {
    const reply = await buildChatReply(
      parseChatCommand('send 5 to maria'),
      deps({ resolveRecipient: vi.fn(async () => { throw new Error('rpc down') }) }),
    )
    expect(reply.toLowerCase()).toContain("couldn't find")
  })
})

describe('buildChatReply — read / name / help', () => {
  it('name points at onboarding with the parent', async () => {
    const reply = await buildChatReply(parseChatCommand('name'), deps())
    expect(reply).toContain('/onboard')
    expect(reply).toContain('access0x1.eth')
  })

  it('balance + receipt are honest app pointers', async () => {
    expect((await buildChatReply(parseChatCommand('balance'), deps())).toLowerCase()).toContain('balance')
    expect((await buildChatReply(parseChatCommand('receipt'), deps()))).toContain('/dashboard')
  })

  it('help + unknown both return the command list', async () => {
    const help = await buildChatReply(parseChatCommand('help'), deps())
    const unknown = await buildChatReply(parseChatCommand('asdf'), deps())
    expect(help).toContain('send 10 to')
    expect(unknown).toContain('send 10 to')
  })
})
