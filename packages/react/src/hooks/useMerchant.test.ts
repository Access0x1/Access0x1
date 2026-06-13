/**
 * @file Unit tests for {@link useMerchant}.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useMerchant, isUnregistered, mapMerchantTuple } from './useMerchant.js';
import { makeMockClient } from '../test/mockClient.js';
import { NATIVE_TOKEN as ZERO, type Hex } from '../types.js';

const ROUTER: Hex = '0x2222222222222222222222222222222222222222';
const PAYOUT: Hex = '0x3333333333333333333333333333333333333333';
const OWNER: Hex = '0x4444444444444444444444444444444444444444';
const FEE_RECIP: Hex = '0x5555555555555555555555555555555555555555';
const NAME_HASH: Hex = ('0x' + 'ab'.repeat(32)) as Hex;

describe('useMerchant', () => {
  it('maps the merchants() tuple into MerchantInfo', async () => {
    const client = makeMockClient({
      reads: {
        merchants: () => [PAYOUT, OWNER, FEE_RECIP, 50, true, NAME_HASH],
      },
    });

    const { result } = renderHook(() => useMerchant(ROUTER, 7n, client));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.merchant).toEqual({
      id: 7n,
      payout: PAYOUT,
      owner: OWNER,
      feeRecipient: FEE_RECIP,
      feeBps: 50,
      active: true,
      nameHash: NAME_HASH,
    });
    expect(result.current.error).toBeNull();
  });

  it('returns an all-zero (unregistered) record without throwing for an unknown id', async () => {
    const client = makeMockClient({
      reads: {
        merchants: () => [ZERO, ZERO, ZERO, 0, false, ('0x' + '00'.repeat(32)) as Hex],
      },
    });

    const { result } = renderHook(() => useMerchant(ROUTER, 999n, client));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.merchant?.owner).toBe(ZERO);
    expect(result.current.error).toBeNull();
    expect(isUnregistered(result.current.merchant!)).toBe(true);
  });
});

describe('mapMerchantTuple', () => {
  it('coerces feeBps to a number', () => {
    const m = mapMerchantTuple(1n, [PAYOUT, OWNER, FEE_RECIP, 100, true, NAME_HASH]);
    expect(m.feeBps).toBe(100);
    expect(typeof m.feeBps).toBe('number');
  });
});
