import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VERIFICATION_THRESHOLDS,
  decideVerification,
  formatUsd8,
  thresholdsFromInput,
  type VerificationRead,
} from '../src/insight.js';

const NOW = 1_752_800_000n;
const DAY = 86_400n;

/** A healthy read of a strong merchant. */
function strongRead(overrides: Partial<VerificationRead> = {}): VerificationRead {
  return {
    merchant: { paymentCount: 12n, totalUsd8: 500_000_000n, lastPaymentAt: NOW - DAY },
    asOfBlock: 43_900_000n,
    hasIndexingErrors: false,
    ...overrides,
  };
}

describe('formatUsd8', () => {
  it('renders 8-decimal amounts as dollars and cents', () => {
    expect(formatUsd8(500_000_000n)).toBe('$5.00');
    expect(formatUsd8(150_000_000n)).toBe('$1.50');
    expect(formatUsd8(0n)).toBe('$0.00');
  });
});

describe('thresholdsFromInput', () => {
  it('maps whole-dollar minUsd to an 8-decimal floor', () => {
    expect(thresholdsFromInput(1.5).minTotalUsd8).toBe(150_000_000n);
  });
  it('maps maxAgeSeconds to a recency window', () => {
    expect(thresholdsFromInput(undefined, 90).maxRecencySeconds).toBe(90n);
  });
  it('omits floors it was not given', () => {
    expect(thresholdsFromInput()).toEqual({});
  });
});

describe('decideVerification — verdicts', () => {
  it('verifies a strong merchant on a healthy index (defaults: >=1 payment, no floors)', () => {
    const d = decideVerification(strongRead(), { nowSeconds: NOW });
    expect(d.verified).toBe(true);
    expect(d.indexingHealthy).toBe(true);
    expect(d.asOfBlock).toBe(43_900_000n);
    expect(d.reasoning[0]).toBe('as of block 43900000');
  });

  it('does not verify when the min USD floor is not met', () => {
    const d = decideVerification(strongRead({ merchant: { paymentCount: 2n, totalUsd8: 50_000_000n, lastPaymentAt: NOW - DAY } }), {
      nowSeconds: NOW,
      thresholds: thresholdsFromInput(1),
    });
    expect(d.verified).toBe(false);
    expect(d.reasoning.some((r) => r.includes('$0.50 is below'))).toBe(true);
  });

  it('does not verify when the last payment is outside the recency window', () => {
    const d = decideVerification(strongRead({ merchant: { paymentCount: 12n, totalUsd8: 500_000_000n, lastPaymentAt: NOW - 100n * DAY } }), {
      nowSeconds: NOW,
      thresholds: thresholdsFromInput(undefined, Number(90n * DAY)),
    });
    expect(d.verified).toBe(false);
    expect(d.reasoning.some((r) => r.includes('outside the 90d recency window'))).toBe(true);
  });

  it('skips the recency gate when no window is requested', () => {
    const d = decideVerification(strongRead({ merchant: { paymentCount: 1n, totalUsd8: 0n, lastPaymentAt: 0n } }), {
      nowSeconds: NOW,
    });
    expect(d.verified).toBe(true);
    expect(d.reasoning.some((r) => r.includes('recency gate skipped'))).toBe(true);
  });
});

describe('decideVerification — conservative degrade ladder', () => {
  it('degrades to not-verified when the index reports errors, and says so', () => {
    const d = decideVerification(strongRead({ hasIndexingErrors: true }), { nowSeconds: NOW });
    expect(d.verified).toBe(false);
    expect(d.indexingHealthy).toBe(false);
    expect(d.reasoning.some((r) => r.includes('indexing errors'))).toBe(true);
    expect(d.asOfBlock).toBe(43_900_000n);
  });

  it('degrades when no synced block height is reported', () => {
    const d = decideVerification(strongRead({ asOfBlock: null }), { nowSeconds: NOW });
    expect(d.verified).toBe(false);
    expect(d.indexingHealthy).toBe(false);
    expect(d.reasoning[0]).toContain('as of block: unknown');
    expect(d.reasoning.some((r) => r.includes('cannot confirm freshness'))).toBe(true);
  });

  it('does not verify a merchant with no indexed history, on a healthy index', () => {
    const d = decideVerification(strongRead({ merchant: null }), { nowSeconds: NOW });
    expect(d.verified).toBe(false);
    expect(d.indexingHealthy).toBe(true);
    expect(d.reasoning.some((r) => r.includes('no indexed payment history'))).toBe(true);
  });

  it('does not verify and reports unknown block when the read is null', () => {
    const d = decideVerification(null, { nowSeconds: NOW });
    expect(d.verified).toBe(false);
    expect(d.indexingHealthy).toBe(false);
    expect(d.asOfBlock).toBeNull();
    expect(d.reasoning[0]).toContain('as of block: unknown');
  });
});

describe('DEFAULT_VERIFICATION_THRESHOLDS', () => {
  it('is >=1 payment, no volume floor, no recency gate', () => {
    expect(DEFAULT_VERIFICATION_THRESHOLDS).toEqual({
      minPaymentCount: 1n,
      minTotalUsd8: 0n,
      maxRecencySeconds: null,
    });
  });
});
