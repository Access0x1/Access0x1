/**
 * insight.ts — the `verify_payment` decision core. Given a merchant's INDEXED
 * state (payment count, cumulative USD, recency) plus the indexer's own health,
 * it produces a typed verdict plus the `reasoning` that narrates exactly why,
 * the block the data was `asOfBlock`, and whether the index was healthy.
 *
 * It is the same release-decision pattern the rail's own agent-insight module
 * uses, kept deliberately consistent:
 *
 *  1. OFF THE MONEY PATH — a read-only advisory. It never signs or settles; it
 *     can only inform a caller's "has this payment landed?" question.
 *  2. GENERATIVE-TRUTH READS — every number comes from the index. `asOfBlock` is
 *     surfaced on EVERY verdict so a caller never presents a count as timeless.
 *  3. FAIL CONSERVATIVE, SAY SO — a failed read, `hasIndexingErrors`, or a
 *     missing synced-block height DEGRADES the verdict to "not verified" and
 *     records the reason. Absent or degraded data is never read as goodwill.
 *
 * The core is PURE (no I/O), so it is fully deterministic under an explicit
 * `nowSeconds`. The tool layer supplies the indexed read and the clock.
 */

/** The indexed state a verdict is computed against. */
export interface VerificationRead {
  /** The merchant's indexed aggregate, or `null` when the id has no indexed row. */
  readonly merchant: {
    readonly paymentCount: bigint;
    readonly totalUsd8: bigint;
    readonly lastPaymentAt: bigint;
  } | null;
  /** The indexer's synced block height, or `null` when `_meta` was absent. */
  readonly asOfBlock: bigint | null;
  /** True when the subgraph reports indexing errors. */
  readonly hasIndexingErrors: boolean;
}

/** The thresholds an indexed history must clear to count as "payment landed". */
export interface VerificationThresholds {
  /** Minimum count of indexed payments (default 1 — a single settled payment confirms "landed"). */
  readonly minPaymentCount: bigint;
  /** Minimum cumulative indexed USD volume, 8 decimals (default 0 — no volume floor). */
  readonly minTotalUsd8: bigint;
  /** Maximum age (seconds) of the last payment, or `null` to skip the recency gate. */
  readonly maxRecencySeconds: bigint | null;
}

/** The typed verdict. */
export interface VerificationDecision {
  /** Whether the indexed history clears every threshold on a healthy index. */
  readonly verified: boolean;
  /** Ordered, human-readable lines narrating WHY — always includes an "as of block" line first. */
  readonly reasoning: string[];
  /** The block the verdict was computed against, or `null` when unknown. */
  readonly asOfBlock: bigint | null;
  /** Whether the index itself was healthy (no indexing errors, synced-block reported). */
  readonly indexingHealthy: boolean;
}

/** Per-call options. */
export interface VerificationOptions {
  /** Evaluation time in unix seconds; defaults to now. Pass explicitly for determinism. */
  readonly nowSeconds?: bigint;
  /** Threshold overrides merged over {@link DEFAULT_VERIFICATION_THRESHOLDS}. */
  readonly thresholds?: Partial<VerificationThresholds>;
}

/** The default thresholds: at least one indexed payment, no volume floor, no recency gate. */
export const DEFAULT_VERIFICATION_THRESHOLDS: VerificationThresholds = {
  minPaymentCount: 1n,
  minTotalUsd8: 0n,
  maxRecencySeconds: null,
};

const SECONDS_PER_DAY = 86_400n;

/**
 * Format an 8-decimal USD amount as a `$X.YY` string for a reasoning line.
 *
 * @param amount USD amount at 8 decimals (e.g. `500_000_000n` → `"$5.00"`).
 * @returns The dollar string, signed when negative.
 */
export function formatUsd8(amount: bigint): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const whole = magnitude / 100_000_000n;
  const cents = (magnitude % 100_000_000n) / 1_000_000n;
  return `${negative ? '-' : ''}$${whole.toString()}.${cents.toString().padStart(2, '0')}`;
}

/**
 * Build thresholds from the tool's optional `minUsd` / `maxAgeSeconds` inputs.
 *
 * @param minUsd Minimum cumulative USD (whole dollars), or `undefined` for no floor.
 * @param maxAgeSeconds Maximum recency in seconds, or `undefined` to skip the gate.
 * @returns Partial thresholds to merge over the defaults.
 */
export function thresholdsFromInput(minUsd?: number, maxAgeSeconds?: number): Partial<VerificationThresholds> {
  const partial: { minTotalUsd8?: bigint; maxRecencySeconds?: bigint | null } = {};
  if (typeof minUsd === 'number' && Number.isFinite(minUsd) && minUsd > 0) {
    // Round to the nearest 8-decimal integer to avoid float drift in the cents.
    partial.minTotalUsd8 = BigInt(Math.round(minUsd * 1e8));
  }
  if (typeof maxAgeSeconds === 'number' && Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0) {
    partial.maxRecencySeconds = BigInt(Math.floor(maxAgeSeconds));
  }
  return partial;
}

/**
 * The PURE verdict core: given an indexed read (or `null` when the configured
 * index errored) and the thresholds, produce a {@link VerificationDecision}.
 *
 * Degrade ladder (each fails verification and records a reason):
 *  - `read === null` → the configured index returned nothing.
 *  - `hasIndexingErrors` → the index may be incomplete or stale.
 *  - `asOfBlock === null` → freshness cannot be confirmed.
 *  - `merchant === null` → no indexed history for this id.
 * Only a healthy index with a present merchant reaches the count / volume /
 * recency gates.
 *
 * @param read The indexed read, or `null` when the configured index failed.
 * @param opts Optional evaluation time and threshold overrides.
 * @returns The typed verdict with narrated reasoning.
 */
export function decideVerification(
  read: VerificationRead | null,
  opts: VerificationOptions = {},
): VerificationDecision {
  const thresholds: VerificationThresholds = { ...DEFAULT_VERIFICATION_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const now = opts.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const reasoning: string[] = [];

  if (read === null) {
    reasoning.push('as of block: unknown (indexed read returned no data)');
    reasoning.push('indexed payment history is unavailable — not verified by conservative default');
    return { verified: false, reasoning, asOfBlock: null, indexingHealthy: false };
  }

  const asOfBlock = read.asOfBlock;
  reasoning.push(
    asOfBlock === null ? 'as of block: unknown (indexer _meta absent)' : `as of block ${asOfBlock.toString()}`,
  );

  if (read.hasIndexingErrors) {
    reasoning.push(
      'indexer reports indexing errors — data may be incomplete or stale; not verified (conservative)',
    );
    return { verified: false, reasoning, asOfBlock, indexingHealthy: false };
  }

  if (asOfBlock === null) {
    reasoning.push(
      'indexer did not report a synced block height (_meta.block absent) — cannot confirm freshness; not verified (conservative)',
    );
    return { verified: false, reasoning, asOfBlock: null, indexingHealthy: false };
  }

  const merchant = read.merchant;
  if (merchant === null) {
    reasoning.push('merchant has no indexed payment history at this block — not verified by conservative default');
    return { verified: false, reasoning, asOfBlock, indexingHealthy: true };
  }

  reasoning.push('indexer healthy: no indexing errors reported');

  const countOk = merchant.paymentCount >= thresholds.minPaymentCount;
  reasoning.push(
    `payment count ${merchant.paymentCount.toString()} ${countOk ? 'meets' : 'is below'} the >= ${thresholds.minPaymentCount.toString()} minimum`,
  );

  const volumeOk = merchant.totalUsd8 >= thresholds.minTotalUsd8;
  reasoning.push(
    `indexed volume ${formatUsd8(merchant.totalUsd8)} ${volumeOk ? 'meets' : 'is below'} the >= ${formatUsd8(thresholds.minTotalUsd8)} minimum`,
  );

  let recencyOk = true;
  if (thresholds.maxRecencySeconds !== null) {
    const windowDays = (thresholds.maxRecencySeconds / SECONDS_PER_DAY).toString();
    const ageSeconds = now - merchant.lastPaymentAt;
    recencyOk = merchant.lastPaymentAt > 0n && ageSeconds >= 0n && ageSeconds <= thresholds.maxRecencySeconds;
    if (merchant.lastPaymentAt === 0n) {
      reasoning.push('no last-payment timestamp recorded — recency cannot be confirmed');
    } else if (ageSeconds < 0n) {
      reasoning.push('last-payment timestamp is ahead of the evaluation time — recency treated as unverified');
    } else {
      reasoning.push(
        `last payment ~${(ageSeconds / SECONDS_PER_DAY).toString()}d ago is ${recencyOk ? 'within' : 'outside'} the ${windowDays}d recency window`,
      );
    }
  } else {
    reasoning.push('no recency window requested — recency gate skipped');
  }

  const verified = countOk && volumeOk && recencyOk;
  reasoning.push(
    verified
      ? 'all requested thresholds met on a healthy index — payment verified'
      : 'one or more thresholds not met — not verified',
  );
  return { verified, reasoning, asOfBlock, indexingHealthy: true };
}
