/**
 * @file Unit tests for {@link usePayment}.
 *
 * Covers the spec cases: happy-path native, happy-path token (with + without approval), the typed
 * revert cases (underpaid, fee-on-transfer, merchant inactive, stale price), and reset().
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePayment } from './usePayment.js';
import { makeMockClient, revertError, type MockClient } from '../test/mockClient.js';
import { NATIVE_TOKEN, type Hex } from '../types.js';

const ROUTER: Hex = '0x2222222222222222222222222222222222222222';
const USDC: Hex = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TX_HASH: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000001';
const APPROVE_HASH: Hex = '0xdef0000000000000000000000000000000000000000000000000000000000002';
const GROSS_NATIVE = 5n * 10n ** 15n;
const GROSS_TOKEN = 29_000_000n; // 29 USDC, 6 dp

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
      feeAmount: 145000000000000n,
      netAmount: GROSS_NATIVE - 145000000000000n,
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
        quote: () => {
          throw revertError('StalePrice');
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
