/**
 * In-memory payment ledger — the ONE intentional deviation from the
 * `circlefin/arc-nanopayments` blueprint (it uses Supabase; we use an injectable
 * bounded in-memory ring). Called out in the PR body.
 *
 * Invariant: recording a settled payment is BEST-EFFORT. A subscriber that throws
 * must never flip an already-settled payment into a failure (doctrine guardrail
 * law #5 — money paths never swallow the settlement itself, but the ledger is
 * informational, so a ledger failure is isolated from the settle result).
 */

/** A single settled micro-payment, as recorded after Circle settle succeeds. */
export type PaymentEvent = {
  /** The priced endpoint that was served, e.g. "/api/premium/quote". */
  endpoint: string;
  /** Payer address from the settle response; "unknown" if Circle omits it. */
  payer: string;
  /** Decimal USDC amount, e.g. "0.001". */
  amountUsdc: string;
  /** CAIP-2 network id (ARC_TESTNET_NETWORK). */
  network: string;
  /** Circle batch settlement tx hash, or null if not yet surfaced. */
  gatewayTx: string | null;
  /** Record timestamp (Date.now()). */
  ts: number;
};

/** Subscriber notified (best-effort) on every recorded payment. */
export type LedgerSubscriber = (event: PaymentEvent) => void;

/** Max entries retained in the ring; entry MAX+1 evicts the oldest. */
const MAX_ENTRIES = 200;

/** Oldest-first ring of recorded payments (bounded at MAX_ENTRIES). */
const ring: PaymentEvent[] = [];

/** Best-effort subscribers (e.g. the live payment-feed UI panel). */
const subscribers = new Set<LedgerSubscriber>();

/**
 * Record a settled payment.
 *
 * Pushes the event, caps the ring at {@link MAX_ENTRIES} (oldest evicted), then
 * notifies subscribers. Subscriber errors are SWALLOWED — a thrown subscriber
 * never propagates to the settle caller and never flips a settled payment.
 *
 * @param event - the settled payment to record
 * @returns void
 */
export function recordPayment(event: PaymentEvent): void {
  ring.push(event);
  if (ring.length > MAX_ENTRIES) {
    ring.splice(0, ring.length - MAX_ENTRIES);
  }
  for (const sub of subscribers) {
    try {
      sub(event);
    } catch {
      // Isolated: a subscriber error never throws to the caller (law #5).
    }
  }
}

/**
 * Newest-first snapshot of the recorded payments.
 *
 * @returns a shallow copy of the ring, most recent first (callers cannot mutate
 *          the internal ring through the returned array's element order)
 */
export function recentPayments(): PaymentEvent[] {
  return ring.slice().reverse();
}

/**
 * Subscribe to recorded payments (best-effort). Used by the live feed UI.
 *
 * @param sub - the subscriber to notify on each recorded payment
 * @returns an unsubscribe function
 */
export function subscribePayments(sub: LedgerSubscriber): () => void {
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

/** Test-only: clear the ring + subscribers. NOT used in production paths. */
export function __resetLedger(): void {
  ring.length = 0;
  subscribers.clear();
}
