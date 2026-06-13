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

    // laneId called with (chainSelector, asset, recipient); balanceOf with (owner, id)
    const laneCall = client.readContract.mock.calls.find((c) => c[0].functionName === 'laneId');
    expect(laneCall?.[0].args).toEqual([0n, NATIVE_TOKEN, OWNER]);
    const balCall = client.readContract.mock.calls.find((c) => c[0].functionName === 'balanceOf');
    expect(balCall?.[0].args).toEqual([OWNER, 42n]);
  });
});
