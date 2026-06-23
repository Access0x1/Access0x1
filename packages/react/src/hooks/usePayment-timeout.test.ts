import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Estate-audit (HIGH): the receipt wait could hang forever. `receiptPromise`
 * resolves only when a PaymentReceived event is decoded; if the event never
 * arrives or `decodeReceipt` returns null for every log, `await receiptPromise`
 * blocked the pay flow indefinitely (and the watcher never tore down). The wait
 * must race against a ceiling and fail loud.
 *
 * Source-inspection guard (same style as the repo's regression guards): asserts
 * the timeout race + cleanup are present in usePayment.ts.
 */
const src = readFileSync(resolve(__dirname, 'usePayment.ts'), 'utf8');

describe('usePayment receipt wait has a timeout ceiling', () => {
  it('races the receipt promise against a timeout (no infinite hang)', () => {
    expect(src).toMatch(/Promise\.race\(\[\s*receiptPromise/);
  });

  it('rejects with a clear timeout error instead of resolving never', () => {
    expect(src).toMatch(/Timed out waiting for the on-chain payment receipt/);
  });

  it('clears the timeout timer in the finally (no dangling timer after success)', () => {
    expect(src).toMatch(/clearTimeout\(receiptTimeout\)/);
  });
});
