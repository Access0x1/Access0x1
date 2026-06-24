/**
 * @file agentMeter.ts — never-negative daily USD budget for the autonomous agent.
 *
 * Mirrors a standard in-process spend-ledger pattern (`ai_spend_daily`), keyed
 * by UTC day. The meter is the CEI **check**: {@link meterSpendOrThrow} runs before any
 * network effect in {@link "./payPerCall".agentPay}, so an over-cap request short-circuits
 * with zero Circle Gateway calls. Refunds (the money-safety invariant) never throw and never push the day
 * below zero.
 *
 * Server-only (doctrine guardrail #4 / #7): the cap is read from a server env var and is
 * never exposed to the browser. This module imports clean — it has no Dynamic/x402 deps —
 * so it is safe to unit-test in isolation.
 */

import { assertServerOnly } from "./serverOnly.js";

assertServerOnly("agentMeter");

/**
 * Thrown when a spend would push the current UTC day's total over the configured cap.
 * Carries the running `spent` (before the rejected charge) and the `cap` so the route
 * handler can surface a truthful 402 body (law #4) without leaking any secret.
 */
export class BudgetExceeded extends Error {
  /** USD already spent in the current UTC day, before the rejected charge. */
  readonly spent: number;
  /** The configured daily USD cap. */
  readonly cap: number;

  constructor(spent: number, cap: number) {
    super(`BudgetExceeded: spent ${spent} of ${cap} USD daily cap`);
    this.name = "BudgetExceeded";
    this.spent = spent;
    this.cap = cap;
  }
}

/** In-process ledger: a single day key plus the USD spent against it. */
interface Ledger {
  dayKey: string;
  spent: number;
}

/**
 * The ledger is pinned on `globalThis` (O-9) so EVERY route-module instance in the same process
 * shares ONE daily cap. A plain module-level binding gives each Next.js route-module copy (and
 * dev hot-reload) its own ledger, which silently multiplies the intended ceiling by N instances.
 * This mirrors `lib/worldid/nullifierStore.ts`, `lib/oidc/subjectStore.ts`, and the branding
 * store. The seam still swaps for a durable/shared store (KV/Postgres) later with no call-site
 * changes; persistence across process restarts is the next step (acknowledged hackathon scope).
 */
const GLOBAL_KEY = "__ax1_agent_meter__";

function ledgerStore(): Ledger {
  const g = globalThis as unknown as Record<string, Ledger | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { dayKey: "", spent: 0 };
  return g[GLOBAL_KEY] as Ledger;
}

/** `YYYY-MM-DD` in UTC — the meter's reset boundary. */
function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Read the daily USD cap from the server env. Defaults to 0 (everything blocked) when
 * unset, which fails safe — the agent cannot spend without an explicit budget.
 *
 * @returns The configured cap in USD; `0` when `AGENT_DAILY_USD_CAP` is unset or invalid.
 */
function dailyCapUsd(): number {
  const raw = process.env.AGENT_DAILY_USD_CAP;
  const cap = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(cap) && cap >= 0 ? cap : 0;
}

/** Roll the ledger forward to the current UTC day, resetting spend on a new day. */
function rollToToday(): void {
  const ledger = ledgerStore();
  const today = utcDayKey();
  if (ledger.dayKey !== today) {
    ledger.dayKey = today;
    ledger.spent = 0;
  }
}

/**
 * Reserve `usd` against the current UTC day's budget, or throw if it would exceed the cap.
 *
 * This is the CEI **check**: callers MUST invoke it before any network interaction so a
 * rejected charge produces zero side effects. The charge is recorded only when it fits;
 * an over-cap request leaves the ledger untouched.
 *
 * @param usd The non-negative USD amount to reserve.
 * @returns void
 * @throws {RangeError} if `usd` is negative or not finite.
 * @throws {BudgetExceeded} if the charge would push the day's total over the cap.
 */
export function meterSpendOrThrow(usd: number): void {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError(`meterSpendOrThrow: usd must be a non-negative finite number, got ${usd}`);
  }
  rollToToday();
  const ledger = ledgerStore();
  const cap = dailyCapUsd();
  if (ledger.spent + usd > cap) {
    throw new BudgetExceeded(ledger.spent, cap);
  }
  ledger.spent += usd;
}

/**
 * Restore `usd` to the current UTC day's budget after a charge that did not result in a
 * delivered, paid call (law #5 — refunds are never blocked). Clamps the stored spend at
 * zero so a refund can never make the meter negative, and never throws — a bad argument
 * is treated as a no-op rather than blocking a refund.
 *
 * @param usd The USD amount to restore. Negative / non-finite values are ignored.
 * @returns void
 */
export function meterRefund(usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) {
    return;
  }
  rollToToday();
  const ledger = ledgerStore();
  ledger.spent = Math.max(0, ledger.spent - usd);
}

/**
 * Current USD spent against today's budget. Exposed for the route handler's truthful
 * status reporting and for tests; rolls the ledger to today first.
 *
 * @returns The USD spent in the current UTC day.
 */
export function meterSpent(): number {
  rollToToday();
  return ledgerStore().spent;
}

/**
 * Reset the in-process ledger. Test-only hook — production code never calls this; the
 * meter resets naturally on the UTC day boundary.
 *
 * @returns void
 */
export function __resetMeterForTests(): void {
  const ledger = ledgerStore();
  ledger.dayKey = "";
  ledger.spent = 0;
}
