/**
 * @file Unit tests for the optional {@link usePaymentLanes} hook.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePaymentLanes } from './usePaymentLanes.js';
import { makeMockClient } from '../test/mockClient.js';
import { NATIVE_TOKEN, type Hex } from '../types.js';

const LANES: Hex = '0x6666666666666666666666666666666666666666';
const OWNER: Hex = '0x7777777777777777777777777777777777777777';
const USDC: Hex = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

describe('usePaymentLanes', () => {
  it('derives the lane id then reads balanceOf', async () => {
    const client = makeMockClient({
      reads: {
        laneId: () => 42n,
        balanceOf: () => 100n,
      },
    });

    const { result } = renderHook(() =>
      usePaymentLanes(LANES, OWNER, NATIVE_TOKEN, 0n, client),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.laneId).toBe(42n);
    expect(result.current.balance).toBe(100n);
    expect(result.current.error).toBeNull();

    // laneId called with (chainId, asset, recipient); balanceOf with (owner, id)
    const laneCall = client.readContract.mock.calls.find((c) => c[0].functionName === 'laneId');
    expect(laneCall?.[0].args).toEqual([0n, NATIVE_TOKEN, OWNER]);
    const balCall = client.readContract.mock.calls.find((c) => c[0].functionName === 'balanceOf');
    expect(balCall?.[0].args).toEqual([OWNER, 42n]);
  });
});

describe('usePaymentLanes — error handling', () => {
  it('surfaces a laneId revert and never reads balanceOf', async () => {
    const client = makeMockClient({
      reads: {
        laneId: () => {
          throw new Error('boom: laneId');
        },
        balanceOf: () => 100n,
      },
    });

    const { result } = renderHook(() =>
      usePaymentLanes(LANES, OWNER, NATIVE_TOKEN, 0n, client),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // The first read threw: the error is normalized, and neither id nor balance is set.
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.code).toBe('UNKNOWN');
    expect(result.current.laneId).toBeNull();
    expect(result.current.balance).toBeNull();

    // balanceOf must never be attempted once laneId fails.
    const names = client.readContract.mock.calls.map((c) => c[0].functionName);
    expect(names).toContain('laneId');
    expect(names).not.toContain('balanceOf');
  });

  it('keeps balance null when balanceOf reverts after laneId succeeds', async () => {
    const client = makeMockClient({
      reads: {
        laneId: () => 42n,
        balanceOf: () => {
          throw new Error('boom: balanceOf');
        },
      },
    });

    const { result } = renderHook(() =>
      usePaymentLanes(LANES, OWNER, NATIVE_TOKEN, 0n, client),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // laneId landed before the balance read threw, so it stays visible…
    expect(result.current.laneId).toBe(42n);
    // …but the balance read failed, so balance stays null and the error is surfaced.
    expect(result.current.balance).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.code).toBe('UNKNOWN');
  });
});

describe('usePaymentLanes — parameter variations', () => {
  it.each([0n, 1n, 8453n])('forwards chainId %s verbatim to laneId', async (chainId) => {
    const client = makeMockClient({
      reads: { laneId: () => 1n, balanceOf: () => 0n },
    });

    const { result } = renderHook(() =>
      usePaymentLanes(LANES, OWNER, NATIVE_TOKEN, chainId, client),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const laneCall = client.readContract.mock.calls.find((c) => c[0].functionName === 'laneId');
    expect(laneCall?.[0].args).toEqual([chainId, NATIVE_TOKEN, OWNER]);
  });

  it.each([
    ['native', NATIVE_TOKEN],
    ['custom token', USDC],
  ])('forwards the %s asset to laneId', async (_label, asset) => {
    const client = makeMockClient({
      reads: { laneId: () => 1n, balanceOf: () => 0n },
    });

    const { result } = renderHook(() => usePaymentLanes(LANES, OWNER, asset, 0n, client));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const laneCall = client.readContract.mock.calls.find((c) => c[0].functionName === 'laneId');
    expect(laneCall?.[0].args).toEqual([0n, asset, OWNER]);
  });

  it('routes the owner into both the laneId recipient and the balanceOf owner', async () => {
    const otherOwner: Hex = '0x8888888888888888888888888888888888888888';
    const client = makeMockClient({
      reads: { laneId: () => 7n, balanceOf: () => 9n },
    });

    const { result } = renderHook(() =>
      usePaymentLanes(LANES, otherOwner, NATIVE_TOKEN, 0n, client),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const laneCall = client.readContract.mock.calls.find((c) => c[0].functionName === 'laneId');
    expect(laneCall?.[0].args).toEqual([0n, NATIVE_TOKEN, otherOwner]);
    const balCall = client.readContract.mock.calls.find((c) => c[0].functionName === 'balanceOf');
    expect(balCall?.[0].args).toEqual([otherOwner, 7n]);
  });
});

describe('usePaymentLanes — no client', () => {
  it('attempts no reads and stays null when client is undefined', async () => {
    const { result } = renderHook(() =>
      usePaymentLanes(LANES, OWNER, NATIVE_TOKEN, 0n, undefined),
    );

    // Nothing to read against: the effect short-circuits, so state never leaves its initial shape.
    expect(result.current.laneId).toBeNull();
    expect(result.current.balance).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe('usePaymentLanes — dependency changes', () => {
  it('re-reads when the lanes address changes', async () => {
    const client = makeMockClient({
      reads: { laneId: () => 1n, balanceOf: () => 0n },
    });
    const otherLanes: Hex = '0x9999999999999999999999999999999999999999';

    const { result, rerender } = renderHook(
      ({ lanes }) => usePaymentLanes(lanes, OWNER, NATIVE_TOKEN, 0n, client),
      { initialProps: { lanes: LANES } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const firstReads = client.readContract.mock.calls.filter(
      (c) => c[0].functionName === 'laneId',
    ).length;
    expect(firstReads).toBe(1);

    rerender({ lanes: otherLanes });

    await waitFor(() => {
      const reads = client.readContract.mock.calls.filter((c) => c[0].functionName === 'laneId');
      expect(reads.length).toBe(2);
      expect(reads[1]?.[0].address).toBe(otherLanes);
    });
  });

  it('re-reads when the owner changes', async () => {
    const client = makeMockClient({
      reads: { laneId: () => 1n, balanceOf: () => 0n },
    });
    const otherOwner: Hex = '0x8888888888888888888888888888888888888888';

    const { result, rerender } = renderHook(
      ({ owner }) => usePaymentLanes(LANES, owner, NATIVE_TOKEN, 0n, client),
      { initialProps: { owner: OWNER } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    rerender({ owner: otherOwner });

    await waitFor(() => {
      const reads = client.readContract.mock.calls.filter((c) => c[0].functionName === 'laneId');
      expect(reads.length).toBe(2);
      expect(reads[1]?.[0].args).toEqual([0n, NATIVE_TOKEN, otherOwner]);
    });
  });

  it('re-reads when the asset changes', async () => {
    const client = makeMockClient({
      reads: { laneId: () => 1n, balanceOf: () => 0n },
    });

    const { result, rerender } = renderHook(
      ({ asset }) => usePaymentLanes(LANES, OWNER, asset, 0n, client),
      { initialProps: { asset: NATIVE_TOKEN as Hex } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    rerender({ asset: USDC });

    await waitFor(() => {
      const reads = client.readContract.mock.calls.filter((c) => c[0].functionName === 'laneId');
      expect(reads.length).toBe(2);
      expect(reads[1]?.[0].args).toEqual([0n, USDC, OWNER]);
    });
  });
});

describe('usePaymentLanes — read ordering', () => {
  it('exposes the lane id before the balance resolves', async () => {
    // Hold balanceOf open so we can observe the in-between state: laneId landed, balance still null.
    let releaseBalance!: (value: bigint) => void;
    const balancePending = new Promise<bigint>((resolve) => {
      releaseBalance = resolve;
    });

    const client = makeMockClient({
      reads: {
        laneId: () => 42n,
        balanceOf: () => balancePending,
      },
    });

    const { result } = renderHook(() =>
      usePaymentLanes(LANES, OWNER, NATIVE_TOKEN, 0n, client),
    );

    // laneId resolves first and is committed while the balance read is still in flight.
    await waitFor(() => expect(result.current.laneId).toBe(42n));
    expect(result.current.balance).toBeNull();
    expect(result.current.isLoading).toBe(true);

    // Releasing the balance completes the sequence.
    releaseBalance(100n);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.laneId).toBe(42n);
    expect(result.current.balance).toBe(100n);
    expect(result.current.error).toBeNull();
  });
});
