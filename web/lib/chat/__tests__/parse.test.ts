/**
 * @file parse.test.ts — the chat command brain (pure, offline).
 * Proves the send/pay grammar, the read commands, and that anything ambiguous
 * degrades to `unknown` (never a mis-parsed payment).
 */
import { describe, expect, it } from 'vitest'
import { parseChatCommand, normalizeRecipient } from '../parse'

describe('parseChatCommand — send/pay', () => {
  it('parses "send 10 to @maria"', () => {
    expect(parseChatCommand('send 10 to @maria')).toEqual({
      kind: 'send',
      amountUsd: 10,
      recipient: 'maria',
    })
  })

  it('parses "pay $5 to maria.eth" (keeps the .eth)', () => {
    expect(parseChatCommand('pay $5 to maria.eth')).toEqual({
      kind: 'send',
      amountUsd: 5,
      recipient: 'maria.eth',
    })
  })

  it('parses "transfer 2.50 usdc to bob" (drops the currency word)', () => {
    expect(parseChatCommand('transfer 2.50 usdc to bob')).toEqual({
      kind: 'send',
      amountUsd: 2.5,
      recipient: 'bob',
    })
  })

  it('handles the slash-command form "/send 3 to @al"', () => {
    expect(parseChatCommand('/send 3 to @al')).toEqual({
      kind: 'send',
      amountUsd: 3,
      recipient: 'al',
    })
  })

  it('works without the word "to"', () => {
    expect(parseChatCommand('send 7 maria')).toEqual({
      kind: 'send',
      amountUsd: 7,
      recipient: 'maria',
    })
  })

  it('rejects a send with no recipient (amount only) → unknown', () => {
    expect(parseChatCommand('send 10').kind).toBe('unknown')
    expect(parseChatCommand('pay 5 usd').kind).toBe('unknown')
  })

  it('rejects a non-positive or non-numeric amount → unknown', () => {
    expect(parseChatCommand('send 0 to maria').kind).toBe('unknown')
    expect(parseChatCommand('send lots to maria').kind).toBe('unknown')
  })
})

describe('parseChatCommand — read commands', () => {
  it('recognizes balance / receipt / name / help / start', () => {
    expect(parseChatCommand('balance').kind).toBe('balance')
    expect(parseChatCommand('receipt').kind).toBe('receipt')
    expect(parseChatCommand('receipts').kind).toBe('receipt')
    expect(parseChatCommand('name').kind).toBe('name')
    expect(parseChatCommand('claim').kind).toBe('name')
    expect(parseChatCommand('help').kind).toBe('help')
    expect(parseChatCommand('/start').kind).toBe('help')
  })

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(parseChatCommand('  HELP  ').kind).toBe('help')
    expect(parseChatCommand('SEND 4 TO @Bob')).toEqual({
      kind: 'send',
      amountUsd: 4,
      recipient: 'bob',
    })
  })

  it('empty / gibberish → unknown', () => {
    expect(parseChatCommand('').kind).toBe('unknown')
    expect(parseChatCommand('hello there').kind).toBe('unknown')
  })
})

describe('normalizeRecipient', () => {
  it('drops @, lowercases, trims trailing punctuation, keeps dots', () => {
    expect(normalizeRecipient('@Maria')).toBe('maria')
    expect(normalizeRecipient('maria.eth,')).toBe('maria.eth')
    expect(normalizeRecipient('BOB!')).toBe('bob')
  })
})
