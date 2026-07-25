/**
 * withTimeout.test.ts — a stalled load becomes a failure, never a permanent spinner.
 *
 * The bug this closes: both checkout pages rendered a pulsing skeleton while a read was
 * in flight and cleared it only in `finally`. `fetch` has no default timeout, so a
 * connection that opened and went quiet pulsed forever — on a payment page, with no
 * message and nothing to click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHECKOUT_LOAD_TIMEOUT_MS, TimeoutError, withTimeout } from '../withTimeout'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('withTimeout', () => {
  it('passes through a value that arrives in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok')
  })

  it('rejects with TimeoutError once the deadline passes', async () => {
    // A promise that never settles — exactly the hung connection being defended against.
    const forever = new Promise<string>(() => {})
    const p = withTimeout(forever, 1000)
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
  })

  it('preserves the original error rather than masking it as a timeout', async () => {
    // A real failure must stay legible: the UI words a timeout differently from an RPC
    // fault, and collapsing the two would tell the buyer the wrong thing.
    const boom = new Error('RPC exploded')
    await expect(withTimeout(Promise.reject(boom), 1000)).rejects.toThrowError('RPC exploded')
  })

  it('clears the timer when the work wins, leaving nothing pending', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    await withTimeout(Promise.resolve(1), 1000)
    expect(clear).toHaveBeenCalled()
  })

  it('clears the timer when the work REJECTS too', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    await withTimeout(Promise.reject(new Error('x')), 1000).catch(() => undefined)
    expect(clear).toHaveBeenCalled()
  })

  it('defaults to a deadline a person will still wait out', () => {
    // Long enough for a slow-but-working testnet RPC, short enough that nobody has
    // already decided the page is broken.
    expect(CHECKOUT_LOAD_TIMEOUT_MS).toBe(10_000)
  })
})
