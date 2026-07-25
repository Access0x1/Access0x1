/**
 * walletError.test.ts — what a merchant reads when a transaction fails.
 *
 * Every case here is a real thing a wallet throws. The bar is not "we returned a
 * string" but "the sentence names the thing the person has to go do".
 */
import { describe, expect, it } from 'vitest'

import { humanizeWalletError } from '../walletError.js'

/** A viem-shaped error: long multi-line `message`, concise `shortMessage`. */
function viemError(message: string, shortMessage?: string): Error {
  const err = new Error(message)
  if (shortMessage) (err as Error & { shortMessage?: string }).shortMessage = shortMessage
  return err
}

describe('humanizeWalletError', () => {
  it('names the gas cliff AND where to fix it (the fix is outside the app)', () => {
    const out = humanizeWalletError(
      new Error('insufficient funds for intrinsic transaction cost'),
    )
    expect(out).toMatch(/gas/i)
    expect(out).toMatch(/faucet/i)
  })

  it('says the user rejected it, rather than reporting a failure they caused', () => {
    expect(humanizeWalletError(new Error('User rejected the request.'))).toMatch(/you rejected/i)
    expect(humanizeWalletError(new Error('User denied transaction signature'))).toMatch(
      /you rejected/i,
    )
  })

  it('turns a stale nonce into an instruction, not a diagnosis', () => {
    expect(humanizeWalletError(new Error('nonce too low'))).toMatch(/refresh/i)
  })

  it('tells a wrong-network user to switch', () => {
    expect(humanizeWalletError(new Error('chain mismatch: wallet on 1, tx for 84532'))).toMatch(
      /switch networks/i,
    )
  })

  it('prefers a caller’s custom revert over any generic match', () => {
    const known = { Foo__AlreadyClaimed: 'This repo is already claimed.' }
    // The raw text ALSO contains "insufficient funds"; the specific one must win.
    const err = new Error('reverted: Foo__AlreadyClaimed (insufficient funds ...)')
    expect(humanizeWalletError(err, known)).toBe('This repo is already claimed.')
  })

  it('never returns the multi-line dump — the reason this module exists', () => {
    const dump = viemError(
      'Execution reverted.\n\nRequest Arguments:\n  from: 0xabc\n  data: 0xdeadbeef' +
        '\n\nDocs: https://viem.sh/docs/contract/writeContract\nVersion: viem@2',
      'Execution reverted for an unknown reason.',
    )
    const out = humanizeWalletError(dump)
    expect(out).not.toContain('\n')
    expect(out).not.toContain('0xdeadbeef')
    expect(out).toBe('Execution reverted for an unknown reason.')
  })

  it('falls back to the first line when there is no shortMessage', () => {
    expect(humanizeWalletError(new Error('boom\nstack frame 1\nstack frame 2'))).toBe('boom')
  })

  it('never returns an empty string, whatever it is handed', () => {
    for (const input of [new Error(''), undefined, null, {}, '']) {
      expect(humanizeWalletError(input).length).toBeGreaterThan(0)
    }
  })
})
