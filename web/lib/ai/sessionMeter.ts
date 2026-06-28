/**
 * @file sessionMeter.ts — the per-session, budget-capped spend meter for the
 * "connect an AI API" feature. An OFF-CHAIN mirror of `SessionGrant`'s on-chain
 * budget ceiling (`src/SessionGrant.sol`: `remaining()` / `spend()`), keyed by
 * the same bytes32 session id.
 *
 * WHY A MIRROR (the honest boundary — law #4). SessionGrant on-chain is the
 * AUTHORITATIVE ceiling: an owner signs a budget-capped, time-bounded grant; the
 * delegate calls `spend()` and the chain rejects once the budget is exhausted.
 * This module does NOT replace that — it is the SAME accounting, enforced at the
 * HTTP edge so a metered AI call is rejected BEFORE any x402 settlement happens
 * (CEI: check the budget, THEN move money). The on-chain `spend()` is the durable
 * record of truth; this in-process meter is the fast pre-settle guard that keeps a
 * runaway agent from settling 10,000 micro-payments before the chain catches up.
 *
 * The seam to close that gap is explicit: when a relayer is wired (it is NOT in
 * this minimal version), a settled call would also submit `SessionGrant.spend()`
 * on-chain so the two ledgers converge. Until then this meter is the enforcing
 * edge and the docs say so plainly — no pretend on-chain debit.
 *
 * DOCTRINE:
 *  - law #4 (truth in copy): the budget is the spend CEILING, never a wallet —
 *    this module moves NO money and holds NO custody, exactly like SessionGrant.
 *  - law #5 (money paths never swallow): {@link refundSession} restores budget on
 *    a call that did not deliver a paid result, and never pushes a session below
 *    zero or above its cap.
 *  - CEI: {@link reserveOrThrow} is the CHECK — it runs before the x402 settle in
 *    the gateway, so an over-budget request settles nothing.
 *
 * PERSISTENCE: like the rest of this repo's stores (`lib/oidc/subjectStore.ts`,
 * `lib/worldid/nullifierStore.ts`, `lib/agent/agentMeter.ts`), an in-process map
 * pinned on `globalThis` so every Next.js route-module instance shares ONE ledger
 * (and it survives dev hot-reload). The `openSession` / `reserveOrThrow` interface
 * is the SEAM a durable KV/Postgres store — or a direct on-chain
 * `SessionGrant.remaining()` read — swaps behind later with zero call-site changes.
 *
 * AMOUNTS: all budgets are 6-decimal atomic USDC (`bigint`), matching
 * `SessionGrant.budgetCap` / `spend(amount)` on-chain and the x402 atomic amount
 * in `lib/x402.ts`. There is no float in the money path here.
 */

/** A 0x-prefixed session id (= `keccak256(owner, delegate, nonce)` on-chain). */
export type SessionId = `0x${string}`;

/** Thrown when a reserve would push a session over its budget cap or it is dead. */
export class SessionBudgetExceeded extends Error {
  /** The session this charge was rejected against. */
  readonly sessionId: SessionId;
  /** Atomic-USDC budget still available before the rejected charge. */
  readonly remaining: bigint;
  /** Atomic-USDC amount that was requested. */
  readonly requested: bigint;

  constructor(sessionId: SessionId, remaining: bigint, requested: bigint) {
    super(
      `SessionBudgetExceeded: session ${sessionId} has ${remaining.toString()} atomic-USDC left, ` +
        `requested ${requested.toString()}`,
    );
    this.name = "SessionBudgetExceeded";
    this.sessionId = sessionId;
    this.remaining = remaining;
    this.requested = requested;
  }
}

/** Thrown when a session id is not known to this meter (no grant opened here). */
export class SessionUnknown extends Error {
  readonly sessionId: SessionId;
  constructor(sessionId: SessionId) {
    super(`SessionUnknown: no open session for id ${sessionId}`);
    this.name = "SessionUnknown";
    this.sessionId = sessionId;
  }
}

/** One session record — the off-chain twin of `SessionGrant.Session`. */
interface SessionRecord {
  /** Atomic-USDC total budget (== on-chain `budgetCap`). */
  budgetCap: bigint;
  /** Atomic-USDC spent so far (== on-chain `spent`). */
  spent: bigint;
  /** Unix-second expiry (== on-chain `expiry`); `spend` is allowed at exactly expiry. */
  expiry: number;
  /** Owner-revoked kill switch (== on-chain `revoked`). */
  revoked: boolean;
}

/** The pinned ledger: session id → record. */
const GLOBAL_KEY = "__ax1_ai_session_meter__";

function ledger(): Map<SessionId, SessionRecord> {
  const g = globalThis as unknown as Record<string, Map<SessionId, SessionRecord> | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map<SessionId, SessionRecord>();
  return g[GLOBAL_KEY] as Map<SessionId, SessionRecord>;
}

/** Current unix seconds (injectable point left implicit; tests set expiry far out). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Open (or replace) a session's off-chain budget mirror.
 *
 * Mirrors `SessionGrant.openSession`/`openSessionFor` at the edge: an owner has
 * signed a grant for `budgetCap` until `expiry`; this records the same ceiling so
 * the gateway can pre-check spends. Re-opening the same id resets the mirror to a
 * fresh budget (the caller is asserting the on-chain grant for this id).
 *
 * @param sessionId The bytes32 session id (= on-chain `computeSessionId`).
 * @param budgetCap Atomic-USDC total budget (must be > 0, like on-chain).
 * @param expiry    Unix-second expiry (must be in the future, like on-chain).
 * @throws {RangeError} if `budgetCap <= 0` or `expiry` is not a future unix second.
 */
export function openSession(sessionId: SessionId, budgetCap: bigint, expiry: number): void {
  if (budgetCap <= 0n) {
    throw new RangeError(`openSession: budgetCap must be > 0 (SessionGrant__ZeroBudget), got ${budgetCap}`);
  }
  if (!Number.isInteger(expiry) || expiry <= nowSeconds()) {
    throw new RangeError(`openSession: expiry must be a future unix second, got ${expiry}`);
  }
  ledger().set(sessionId, { budgetCap, spent: 0n, expiry, revoked: false });
}

/**
 * Atomic-USDC budget still available for `sessionId`. Returns `0n` for any dead
 * session (unknown / expired / revoked / exhausted) — the exact contract of the
 * on-chain `SessionGrant.remaining` view, so a caller can gate on one read.
 *
 * @param sessionId The session id.
 * @returns The remaining atomic-USDC budget, or `0n` if the session is dead.
 */
export function remaining(sessionId: SessionId): bigint {
  const s = ledger().get(sessionId);
  if (!s) return 0n;
  if (s.revoked) return 0n;
  if (nowSeconds() > s.expiry) return 0n;
  return s.budgetCap - s.spent; // invariant: spent <= budgetCap
}

/**
 * Reserve `amount` atomic-USDC against a session, or throw. The CEI **check**: the
 * gateway calls this BEFORE the x402 settle, so an over-budget or dead session
 * settles nothing. Mirrors the revert ladder of `SessionGrant.spend`.
 *
 * @param sessionId The session id to charge.
 * @param amount    Atomic-USDC to reserve (must be > 0, like on-chain).
 * @returns The atomic-USDC remaining AFTER this reservation.
 * @throws {RangeError} if `amount <= 0`.
 * @throws {SessionUnknown} if no session was opened for this id.
 * @throws {SessionBudgetExceeded} if the session is revoked, expired, or over budget.
 */
export function reserveOrThrow(sessionId: SessionId, amount: bigint): bigint {
  if (amount <= 0n) {
    throw new RangeError(`reserveOrThrow: amount must be > 0 (SessionGrant__ZeroAmount), got ${amount}`);
  }
  const s = ledger().get(sessionId);
  if (!s) throw new SessionUnknown(sessionId);
  if (s.revoked || nowSeconds() > s.expiry) {
    throw new SessionBudgetExceeded(sessionId, 0n, amount);
  }
  const left = s.budgetCap - s.spent;
  if (amount > left) {
    throw new SessionBudgetExceeded(sessionId, left, amount);
  }
  s.spent += amount; // effect: single budget write, invariant preserved
  return s.budgetCap - s.spent;
}

/**
 * Restore `amount` to a session after a reserved charge that did not deliver a
 * paid result (law #5 — refunds are never blocked). Clamps at zero so a refund can
 * never make `spent` negative; never throws (a bad argument is a no-op, not a
 * blocked refund) and never touches an unknown session.
 *
 * @param sessionId The session id to credit.
 * @param amount    Atomic-USDC to restore (non-positive values are ignored).
 */
export function refundSession(sessionId: SessionId, amount: bigint): void {
  if (amount <= 0n) return;
  const s = ledger().get(sessionId);
  if (!s) return;
  s.spent = s.spent > amount ? s.spent - amount : 0n;
}

/**
 * Owner kill switch — the off-chain twin of `SessionGrant.revoke`. A revoked
 * session is permanently dead here until re-opened. Idempotent; unknown is a no-op.
 *
 * @param sessionId The session id to revoke.
 */
export function revokeSession(sessionId: SessionId): void {
  const s = ledger().get(sessionId);
  if (s) s.revoked = true;
}

/** Test-only: wipe the meter. NOT used in production paths. */
export function __resetSessionMeterForTests(): void {
  const g = globalThis as unknown as Record<string, Map<SessionId, SessionRecord> | undefined>;
  g[GLOBAL_KEY] = new Map<SessionId, SessionRecord>();
}
