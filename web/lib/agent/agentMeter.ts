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
import {
  durableDecrementClamped,
  durableReserveWithinCap,
  durableSet,
  hydrate,
} from "../storage/durableKv.js";

assertServerOnly("agentMeter");

/**
 * The durable-KV namespace for the daily spend ledger. The row is keyed by the UTC
 * day so each day's running total is its own durable record; a restart mid-day
 * restores the day's spend instead of resetting the cap to zero (which would let
 * the agent overspend its daily budget after a Cloud Run cold start). Fail-soft:
 * with no DB configured the meter is the unchanged in-memory ledger.
 */
const KV_NAMESPACE = "agent:meter";

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
 * store. The ledger is now WRITE-THROUGH to the durable store (`lib/storage/durableKv.ts`)
 * when a DB is configured — `meterSpendOrThrow`/`meterRefund` persist the day's running
 * total and the module hydrates it at boot — so a restart mid-day restores the spend
 * instead of resetting the cap. Fail-soft + no call-site changes; without a DB it is the
 * unchanged in-memory ledger.
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
 * Mirror the current day's running total to the durable store (best-effort, fail-
 * soft, no-op without a DB). Keyed by the UTC day so each day is its own row. Never
 * throws — a DB hiccup must not break a spend/refund, which is authoritative in the
 * in-memory ledger.
 */
function persist(): void {
  const ledger = ledgerStore();
  if (!ledger.dayKey) return;
  durableSet(KV_NAMESPACE, ledger.dayKey, { dayKey: ledger.dayKey, spent: ledger.spent });
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
  persist();
}

/**
 * DURABLE, cross-instance spend reservation — the production entry point (the async
 * sibling of {@link meterSpendOrThrow}). The sync in-memory ledger is a PER-PROCESS
 * ceiling: on Cloud Run each instance boots with an empty ledger, so `meterSpendOrThrow`
 * alone lets N instances EACH spend up to the full cap (a real money-safety gap, since
 * the durable write-through is last-write-wins, not an atomic counter). This reserves
 * against the DURABLE row in ONE atomic statement, so the cap is enforced GLOBALLY.
 *
 * Order (CEI check): (1) the in-memory ceiling rejects fast and is never weaker than
 * before; (2) the durable atomic reserve is authoritative across instances. Fail-soft:
 * with no DB (or a DB error) the durable step returns `undefined` and we fall back to
 * the in-memory reserve + best-effort write-through — no worse than the prior behaviour.
 *
 * @param usd The non-negative USD amount to reserve.
 * @throws {RangeError} if `usd` is negative or not finite.
 * @throws {BudgetExceeded} if the charge would breach the per-instance OR the shared cap.
 */
export async function reserveDailySpend(usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError(`reserveDailySpend: usd must be a non-negative finite number, got ${usd}`);
  }
  rollToToday();
  const ledger = ledgerStore();
  const cap = dailyCapUsd();
  // (1) Per-instance ceiling — a fast reject and a floor that is never weaker than today.
  if (ledger.spent + usd > cap) {
    throw new BudgetExceeded(ledger.spent, cap);
  }
  // (2) Durable atomic reserve — authoritative across instances when a DB is configured.
  const durable = await durableReserveWithinCap(KV_NAMESPACE, ledger.dayKey, usd, cap);
  if (durable === null) {
    // Over the SHARED cap even though this instance's local ledger still had room.
    throw new BudgetExceeded(ledger.spent, cap);
  }
  if (typeof durable === "number") {
    // Adopt the authoritative durable total so the hot in-memory read stays consistent.
    ledger.spent = Math.max(ledger.spent + usd, durable);
    return;
  }
  // No durable atomic path (dev / no DB / fail-soft): in-memory reserve + write-through.
  ledger.spent += usd;
  persist();
}

/**
 * DURABLE refund — the async sibling of {@link meterRefund} used by the production pay
 * path. Restores `usd` after a charge that did not settle (law #5 — refunds are never
 * blocked). Clamps in memory immediately (the hot read stays consistent), then applies
 * the atomic durable decrement so the SHARED total is restored too. Never throws; with
 * no durable atomic path it falls back to the in-memory clamp + best-effort write-through.
 *
 * @param usd The USD amount to restore. Negative / non-finite values are ignored.
 */
export async function refundDailySpend(usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) {
    return;
  }
  rollToToday();
  const ledger = ledgerStore();
  ledger.spent = Math.max(0, ledger.spent - usd);
  const durable = await durableDecrementClamped(KV_NAMESPACE, ledger.dayKey, usd);
  if (typeof durable === "number") {
    ledger.spent = durable; // adopt the authoritative post-refund total
    return;
  }
  persist(); // no atomic path: mirror the clamped in-memory total
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
  persist();
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

/**
 * Hydrate the in-memory ledger from the durable store (durable → memory at boot):
 * restore the CURRENT UTC day's running total so a restart mid-day resumes the cap
 * instead of resetting to zero. Ignores stale prior-day rows (the meter resets on
 * the day boundary anyway). No-op without a DB; fail-soft. Returns rows seen.
 *
 * @returns void
 */
export async function hydrateMeterFromDurable(): Promise<void> {
  const today = utcDayKey();
  await hydrate(KV_NAMESPACE, (key, value) => {
    if (key !== today) return; // only today's spend is still in force
    const row = value as { dayKey?: string; spent?: number } | null;
    const spent = row && Number.isFinite(row.spent) ? Number(row.spent) : NaN;
    if (!Number.isFinite(spent) || spent < 0) return;
    const ledger = ledgerStore();
    ledger.dayKey = today;
    // Take the MAX of what's in memory vs durable so a concurrent in-process spend
    // that already advanced the ledger is never rolled back by a stale read.
    ledger.spent = Math.max(ledger.spent, spent);
  });
}

// ── Durable hydration on first load, once per process (fail-soft, no-op w/o DB) ──
const HYDRATE_FLAG_KEY = "__ax1_agent_meter_hydrated__";
{
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (!g[HYDRATE_FLAG_KEY]) {
    g[HYDRATE_FLAG_KEY] = true;
    void hydrateMeterFromDurable().catch(() => {
      // Fail-soft: never let hydration break the store module load.
    });
  }
}
