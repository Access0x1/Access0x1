/**
 * @file Unit tests for {@link usePayment}.
 *
 * Covers the spec cases: happy-path native, happy-path token (with + without approval), the typed
 * revert cases (underpaid, fee-on-transfer, merchant inactive, stale price), and reset().
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePayment } from './usePayment.js';
import { makeMockClient, revertError, type MockClient } from '../test/mockClient.js';
import { NATIVE_TOKEN, type Hex } from '../types.js';
import { keccak256, toBytes } from 'viem';

const ROUTER: Hex = '0x2222222222222222222222222222222222222222';
const USDC: Hex = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TX_HASH: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000001';
const APPROVE_HASH: Hex = '0xdef0000000000000000000000000000000000000000000000000000000000002';
const GROSS_NATIVE = 5n * 10n ** 15n;
const FEE_NATIVE = 145000000000000n; // total fee leg the router deducts (matches paymentReceivedLog)
const GROSS_TOKEN = 29_000_000n; // 29 USDC, 6 dp
const FEE_TOKEN = 290_000n; // 1% of 29 USDC, in the token's 6 dp

/** Drive a full pay() and fire the success event so the receipt promise resolves. */
function paymentReceivedLog(client: MockClient, overrides: Record<string, unknown> = {}) {
  client.emitEvent({
    eventName: 'PaymentReceived',
    transactionHash: TX_HASH,
    blockNumber: 100n,
    args: {
      merchantId: 42n,
      buyer: client.account,
      token: NATIVE_TOKEN,
      grossAmount: GROSS_NATIVE,
      feeAmount: FEE_NATIVE,
      netAmount: GROSS_NATIVE - FEE_NATIVE,
      usdAmount8: 2_900_000_000n,
      orderId: '0x'.padEnd(66, '0') as Hex,
      srcChainSelector: 0n,
      ...overrides,
    },
  });
}

describe('usePayment — native happy path', () => {
  it('transitions idle → quoting → … → success and populates the receipt', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client, onSuccess }),
    );

    expect(result.current.status).toBe('idle');

    let payPromise!: Promise<void>;
    await act(async () => {
      payPromise = result.current.pay();
      // allow quote + write + watcher registration to run
      await Promise.resolve();
      await Promise.resolve();
    });

    // fire the event so the receipt promise resolves
    await act(async () => {
      paymentReceivedLog(client);
      await payPromise;
    });

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.quote).toBe(GROSS_NATIVE);
    expect(result.current.txHash).toBe(TX_HASH);
    expect(result.current.receipt?.grossAmount).toBe(GROSS_NATIVE);
    expect(result.current.receipt?.txHash).toBe(TX_HASH);
    expect(onSuccess).toHaveBeenCalledOnce();

    // payNative carried msg.value = gross
    const call = client.writeContract.mock.calls.find((c) => c[0].functionName === 'payNative');
    expect(call?.[0].value).toBe(GROSS_NATIVE);
  });
});

describe('usePayment — token happy path', () => {
  it('approves exactly gross when allowance is short, then payToken', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_TOKEN, allowance: () => 0n },
      writes: { approve: () => APPROVE_HASH, payToken: () => TX_HASH },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, token: USDC, routerAddress: ROUTER, client }),
    );

    let payPromise!: Promise<void>;
    await act(async () => {
      payPromise = result.current.pay();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      paymentReceivedLog(client, { token: USDC, grossAmount: GROSS_TOKEN });
      await payPromise;
    });

    await waitFor(() => expect(result.current.status).toBe('success'));

    const approveCall = client.writeContract.mock.calls.find(
      (c) => c[0].functionName === 'approve',
    );
    expect(approveCall).toBeDefined();
    // gas-tight: approval is the EXACT gross, not MaxUint256
    expect(approveCall?.[0].args).toEqual([ROUTER, GROSS_TOKEN]);
  });

  it('skips approve when allowance is already sufficient', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_TOKEN, allowance: () => GROSS_TOKEN + 1n },
      writes: { payToken: () => TX_HASH },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, token: USDC, routerAddress: ROUTER, client }),
    );

    let payPromise!: Promise<void>;
    await act(async () => {
      payPromise = result.current.pay();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      paymentReceivedLog(client, { token: USDC, grossAmount: GROSS_TOKEN });
      await payPromise;
    });

    await waitFor(() => expect(result.current.status).toBe('success'));
    const names = client.writeContract.mock.calls.map((c) => c[0].functionName);
    expect(names).toContain('payToken');
    expect(names).not.toContain('approve');
    expect(names).toHaveLength(1);
  });
});

describe('usePayment — typed reverts', () => {
  it.each([
    ['Access0x1__Underpaid', 'UNDERPAID'],
    ['Access0x1__FeeOnTransferToken', 'FEE_ON_TRANSFER_TOKEN'],
    ['Access0x1__MerchantInactive', 'MERCHANT_INACTIVE'],
  ])('surfaces %s as a typed error', async (revertName, expectedCode) => {
    const isToken = revertName === 'Access0x1__FeeOnTransferToken';
    const client = makeMockClient({
      reads: { quote: () => (isToken ? GROSS_TOKEN : GROSS_NATIVE), allowance: () => 10n ** 30n },
      writes: {
        payNative: () => {
          throw revertError(revertName);
        },
        payToken: () => {
          throw revertError(revertName);
        },
      },
    });
    const onError = vi.fn();

    const { result } = renderHook(() =>
      usePayment({
        merchantId: 42n,
        usdAmount: 29,
        token: isToken ? USDC : undefined,
        routerAddress: ROUTER,
        client,
        onError,
      }),
    );

    await act(async () => {
      await result.current.pay();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.code).toBe(expectedCode);
    expect(result.current.receipt).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('surfaces a stale-price revert from the quote read', async () => {
    const client = makeMockClient({
      reads: {
        // The router surfaces the FULLY-QUALIFIED OracleLib selector — `OracleLib__StalePrice`, not a
        // bare `StalePrice` — so the mock must throw that exact name to exercise the real mapping path.
        quote: () => {
          throw revertError('OracleLib__StalePrice');
        },
      },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client }),
    );

    await act(async () => {
      await result.current.pay();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.quoteError?.code).toBe('STALE_PRICE');
    expect(result.current.error?.code).toBe('STALE_PRICE');
  });
});

describe('usePayment — reset', () => {
  it('returns to idle and clears receipt/txHash after a successful payment', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client }),
    );

    let payPromise!: Promise<void>;
    await act(async () => {
      payPromise = result.current.pay();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      paymentReceivedLog(client);
      await payPromise;
    });
    await waitFor(() => expect(result.current.status).toBe('success'));

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.receipt).toBeNull();
    expect(result.current.txHash).toBeNull();
  });
});

describe('usePayment — the receipt is bound to THIS order', () => {
  it('ignores a PaymentReceived for a different orderId (same merchant+buyer), resolves only on the match', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      usePayment({
        merchantId: 42n,
        usdAmount: 29,
        orderId: 'order-A',
        routerAddress: ROUTER,
        client,
        onSuccess,
      }),
    );

    let payPromise!: Promise<void>;
    await act(async () => {
      payPromise = result.current.pay();
      await Promise.resolve();
      await Promise.resolve();
    });

    // A concurrent payment by the SAME buyer to the SAME merchant for a DIFFERENT
    // order (e.g. a second checkout tab) fires first. The event filter matches on
    // the indexed {merchantId, buyer}, so it reaches this watcher — but it must NOT
    // resolve THIS hook (wrong order ⇒ wrong amount/receipt).
    await act(async () => {
      paymentReceivedLog(client, { orderId: keccak256(toBytes('order-B')) });
      await Promise.resolve();
    });
    expect(result.current.status).not.toBe('success');
    expect(onSuccess).not.toHaveBeenCalled();

    // The matching receipt resolves it.
    await act(async () => {
      paymentReceivedLog(client, { orderId: keccak256(toBytes('order-A')) });
      await payPromise;
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(result.current.receipt?.orderId).toBe(keccak256(toBytes('order-A')));
  });

  it('the FIRST matching orderId wins — a second matching log does not re-resolve', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client, onSuccess }),
    );

    let payPromise!: Promise<void>;
    await act(async () => {
      payPromise = result.current.pay();
      await Promise.resolve();
      await Promise.resolve();
    });

    // First match resolves the receipt; capture which block it bound to.
    await act(async () => {
      paymentReceivedLog(client, { blockNumber: 100n });
      await payPromise;
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(result.current.receipt?.blockNumber).toBe(100n);

    // The watcher is torn down after the first match (finally → unwatch), so a
    // late second log for the same order is dropped — emitEvent has no watcher.
    expect(() => paymentReceivedLog(client, { blockNumber: 999n })).toThrow(/no active watcher/);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(result.current.receipt?.blockNumber).toBe(100n);
  });
});

describe('usePayment — quote read error paths', () => {
  it('surfaces MERCHANT_NOT_FOUND from the quote read (distinct from MERCHANT_INACTIVE)', async () => {
    const client = makeMockClient({
      reads: {
        quote: () => {
          throw revertError('Access0x1__MerchantNotFound');
        },
      },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client }),
    );

    await act(async () => {
      await result.current.pay();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.quoteError?.code).toBe('MERCHANT_NOT_FOUND');
    expect(result.current.error?.code).toBe('MERCHANT_NOT_FOUND');
    // It is NOT the inactive code — the two reverts must not collapse together.
    expect(result.current.error?.code).not.toBe('MERCHANT_INACTIVE');
    expect(result.current.receipt).toBeNull();
  });

  it('surfaces TOKEN_NOT_ALLOWED from the quote read', async () => {
    const client = makeMockClient({
      reads: {
        quote: () => {
          throw revertError('Access0x1__TokenNotAllowed');
        },
      },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, token: USDC, routerAddress: ROUTER, client }),
    );

    await act(async () => {
      await result.current.pay();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.quoteError?.code).toBe('TOKEN_NOT_ALLOWED');
    expect(result.current.error?.code).toBe('TOKEN_NOT_ALLOWED');
  });

  it('surfaces ZERO_AMOUNT from the quote read (usdAmount8 === 0)', async () => {
    const client = makeMockClient({
      reads: {
        quote: (args) => {
          // The router reverts Access0x1__ZeroAmount when the 8-dp amount is zero.
          const usdAmount8 = (args.args as readonly unknown[])[2];
          expect(usdAmount8).toBe(0n);
          throw revertError('Access0x1__ZeroAmount');
        },
      },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 0, routerAddress: ROUTER, client }),
    );

    await act(async () => {
      await result.current.pay();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.quoteError?.code).toBe('ZERO_AMOUNT');
    expect(result.current.error?.code).toBe('ZERO_AMOUNT');
  });
});

describe('usePayment — allowance edge cases', () => {
  it('skips approve when allowance EXACTLY equals gross (allowance < gross is false)', async () => {
    const client = makeMockClient({
      // Boundary: allowance === gross. The guard is `allowance < gross`, so this must NOT approve.
      reads: { quote: () => GROSS_TOKEN, allowance: () => GROSS_TOKEN },
      writes: { payToken: () => TX_HASH },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, token: USDC, routerAddress: ROUTER, client }),
    );

    let payPromise!: Promise<void>;
    await act(async () => {
      payPromise = result.current.pay();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      paymentReceivedLog(client, { token: USDC, grossAmount: GROSS_TOKEN });
      await payPromise;
    });

    await waitFor(() => expect(result.current.status).toBe('success'));
    const names = client.writeContract.mock.calls.map((c) => c[0].functionName);
    expect(names).not.toContain('approve');
    expect(names).toEqual(['payToken']);
  });

  it('fails the pay flow when the allowance read throws (never reaches approve/pay)', async () => {
    const client = makeMockClient({
      reads: {
        quote: () => GROSS_TOKEN,
        allowance: () => {
          throw new Error('RPC: allowance read failed');
        },
      },
      writes: { approve: () => APPROVE_HASH, payToken: () => TX_HASH },
    });
    const onError = vi.fn();

    const { result } = renderHook(() =>
      usePayment({
        merchantId: 42n,
        usdAmount: 29,
        token: USDC,
        routerAddress: ROUTER,
        client,
        onError,
      }),
    );

    await act(async () => {
      await result.current.pay();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    // The quote succeeded, so quoteError stays null; the failure is on the pay path.
    expect(result.current.quote).toBe(GROSS_TOKEN);
    expect(result.current.quoteError).toBeNull();
    expect(result.current.error?.code).toBe('UNKNOWN');
    expect(onError).toHaveBeenCalledOnce();
    // No write of any kind happened — we bailed before approve and before payToken.
    expect(client.writeContract).not.toHaveBeenCalled();
    expect(result.current.txHash).toBeNull();
    expect(result.current.receipt).toBeNull();
  });
});

describe('usePayment — account / client edge cases', () => {
  it('fails with NO_WALLET when no client is supplied (client == null mid-config)', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client: undefined, onError }),
    );

    await act(async () => {
      await result.current.pay();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.code).toBe('NO_WALLET');
    expect(onError).toHaveBeenCalledOnce();
    // We never even got to a quote.
    expect(result.current.quote).toBeNull();
  });

  it('fails with NO_WALLET when the client has no connected account', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });
    // Simulate a connected client whose wallet disconnected: account is undefined.
    (client as { account?: Hex }).account = undefined;
    const onError = vi.fn();

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client, onError }),
    );

    await act(async () => {
      await result.current.pay();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.code).toBe('NO_WALLET');
    expect(onError).toHaveBeenCalledOnce();
    // The buyer guard runs before the quote, so no read fires.
    expect(client.readContract).not.toHaveBeenCalled();
  });
});

describe('usePayment — receipt ceiling timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out (behaviorally) when the receipt never arrives within the 120s ceiling', async () => {
    vi.useFakeTimers();
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });
    const onError = vi.fn();

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client, onError }),
    );

    await act(async () => {
      const payPromise = result.current.pay();
      // Arm the flow: quote → write → waitForReceipt → Promise.race(timeout) all settle as microtasks.
      await vi.advanceTimersByTimeAsync(0);
      // No PaymentReceived event is ever emitted; blow past the 120s ceiling.
      await vi.advanceTimersByTimeAsync(120_001);
      await payPromise;
    });

    // State is already settled inside act(); assert directly (waitFor would hang under fake timers).
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toContain('Timed out waiting');
    expect(onError).toHaveBeenCalledOnce();
    expect(result.current.receipt).toBeNull();
  }, 20_000);

  it('does NOT time out when the receipt arrives before the ceiling', async () => {
    vi.useFakeTimers();
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client }),
    );

    await act(async () => {
      const payPromise = result.current.pay();
      await vi.advanceTimersByTimeAsync(0);
      // Receipt lands well before the ceiling, then nudge the clock past 120s.
      paymentReceivedLog(client);
      await vi.advanceTimersByTimeAsync(120_001);
      await payPromise;
    });

    // Settled inside act(); assert directly (waitFor would hang under fake timers).
    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeNull();
  }, 20_000);
});

describe('usePayment — receipt field invariants', () => {
  it('conserves value: grossAmount === netAmount + feeAmount, and same-chain selector is 0', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client }),
    );

    let payPromise!: Promise<void>;
    await act(async () => {
      payPromise = result.current.pay();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      paymentReceivedLog(client);
      await payPromise;
    });
    await waitFor(() => expect(result.current.status).toBe('success'));

    const r = result.current.receipt;
    expect(r).not.toBeNull();
    // Conservation invariant: the merchant net plus the protocol fee reconstruct the gross.
    expect(r!.grossAmount).toBe(r!.netAmount + r!.feeAmount);
    // A same-chain settlement carries the zero selector (no cross-chain source).
    expect(r!.srcChainSelector).toBe(0n);
  });
});

describe('usePayment — watcher / timer cleanup on error', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('unsubscribes the watcher (no hanging subscription) when the pay write reverts', async () => {
    let unwatchCount = 0;
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: {
        payNative: () => {
          throw revertError('Access0x1__Underpaid');
        },
      },
    });
    // Wrap watchContractEvent so we can count unsubscribe calls (the finally must tear it down).
    const realWatch = client.watchContractEvent.getMockImplementation()!;
    client.watchContractEvent.mockImplementation((args) => {
      const unwatch = realWatch(args) as () => void;
      return () => {
        unwatchCount += 1;
        unwatch();
      };
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client }),
    );

    await act(async () => {
      await result.current.pay();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.code).toBe('UNDERPAID');
    // The watcher was registered (before the pay write) and torn down in finally — not left hanging.
    expect(client.watchContractEvent).toHaveBeenCalledOnce();
    expect(unwatchCount).toBe(1);
  });

  it('clears the receipt-ceiling timeout on the timeout error path (no dangling timer)', async () => {
    vi.useFakeTimers();
    let unwatchCount = 0;
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });
    const realWatch = client.watchContractEvent.getMockImplementation()!;
    client.watchContractEvent.mockImplementation((args) => {
      const unwatch = realWatch(args) as () => void;
      return () => {
        unwatchCount += 1;
        unwatch();
      };
    });
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client }),
    );

    await act(async () => {
      const payPromise = result.current.pay();
      await vi.advanceTimersByTimeAsync(0);
      // The race arms a setTimeout(120s); let it fire (no receipt ever arrives).
      await vi.advanceTimersByTimeAsync(120_001);
      await payPromise;
    });

    // Settled inside act(); assert directly (waitFor would hang under fake timers).
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toContain('Timed out waiting');
    // finally{} tears down both: the watcher unsubscribes and the timer handle is cleared.
    expect(unwatchCount).toBe(1);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  }, 20_000);
});

describe('usePayment — money-path invariant (receipt conservation)', () => {
  // Invariant 1: every wei/satoshi is accounted for. The router splits gross into a fee leg
  // (platform + merchant surcharge) and the net that lands at the merchant, so on every receipt
  // `netAmount + feeAmount === grossAmount`. The SDK cannot see the platform-vs-merchant split
  // inside `feeAmount` (that's contract-level), but it CAN assert the total is conserved.
  it('conserves the native receipt: netAmount + feeAmount === grossAmount', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, routerAddress: ROUTER, client }),
    );

    let payPromise!: Promise<void>;
    await act(async () => {
      payPromise = result.current.pay();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      paymentReceivedLog(client, {
        grossAmount: GROSS_NATIVE,
        feeAmount: FEE_NATIVE,
        netAmount: GROSS_NATIVE - FEE_NATIVE,
      });
      await payPromise;
    });

    await waitFor(() => expect(result.current.status).toBe('success'));
    const r = result.current.receipt;
    expect(r).not.toBeNull();
    // nothing leaks: gross is split exactly into fee + net.
    expect(r!.netAmount + r!.feeAmount).toBe(r!.grossAmount);
    // and the fee leg is the share actually deducted from gross.
    expect(r!.feeAmount).toBe(r!.grossAmount - r!.netAmount);
    expect(r!.feeAmount).toBe(FEE_NATIVE);
  });

  it('conserves the token receipt: netAmount + feeAmount === grossAmount', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_TOKEN, allowance: () => GROSS_TOKEN },
      writes: { payToken: () => TX_HASH },
    });

    const { result } = renderHook(() =>
      usePayment({ merchantId: 42n, usdAmount: 29, token: USDC, routerAddress: ROUTER, client }),
    );

    let payPromise!: Promise<void>;
    await act(async () => {
      payPromise = result.current.pay();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      paymentReceivedLog(client, {
        token: USDC,
        grossAmount: GROSS_TOKEN,
        feeAmount: FEE_TOKEN,
        netAmount: GROSS_TOKEN - FEE_TOKEN,
      });
      await payPromise;
    });

    await waitFor(() => expect(result.current.status).toBe('success'));
    const r = result.current.receipt;
    expect(r).not.toBeNull();
    expect(r!.netAmount + r!.feeAmount).toBe(r!.grossAmount);
    expect(r!.feeAmount).toBe(r!.grossAmount - r!.netAmount);
    expect(r!.feeAmount).toBe(FEE_TOKEN);
  });
});
