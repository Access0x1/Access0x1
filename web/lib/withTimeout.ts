/**
 * withTimeout.ts — bound a load so a stalled network never becomes a permanent spinner.
 *
 * Both checkout pages rendered `<div className="animate-pulse" />` while a read was in
 * flight and cleared it only in `finally`. viem's HTTP transport has its own timeout so
 * the on-chain read eventually resolves, but a plain `fetch` has NONE by default — a
 * connection that opens and then goes quiet pulses forever.
 *
 * That failure is worse than an error. An error state tells a buyer what happened and
 * offers a retry; an eternal skeleton tells them nothing, and the only move left is to
 * close the tab. On a payment page that is the whole transaction.
 *
 * This is deliberately not a retry helper. It converts "hung" into "failed", which is the
 * state the UI already knows how to present honestly.
 */

/** Thrown when the deadline passes. Distinguishable so a caller can word it properly. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

/**
 * How long a checkout read may take before it is treated as failed.
 *
 * Ten seconds: comfortably longer than a slow-but-working testnet RPC, short enough that
 * a person has not yet decided the page is broken and left.
 */
export const CHECKOUT_LOAD_TIMEOUT_MS = 10_000

/**
 * Race a promise against a deadline.
 *
 * The timer is ALWAYS cleared, including when the work wins — an uncleared timer keeps a
 * pending task alive and, in a test environment, keeps the process from settling.
 *
 * @param work The promise to bound.
 * @param ms Deadline in milliseconds.
 * @returns The work's value.
 * @throws {TimeoutError} when the deadline passes first. The underlying work is not
 *   cancelled (a promise cannot be), it is merely no longer awaited — so callers must
 *   still guard against a late resolution touching state after unmount.
 */
export async function withTimeout<T>(work: Promise<T>, ms = CHECKOUT_LOAD_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
