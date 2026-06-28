/**
 * @file Unit tests for {@link useMerchant}.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useMerchant, isUnregistered, mapMerchantTuple } from './useMerchant.js';
import { makeMockClient } from '../test/mockClient.js';
import { NATIVE_TOKEN as ZERO, type Hex, type MerchantInfo } from '../types.js';

const ROUTER: Hex = '0x2222222222222222222222222222222222222222';
const ROUTER_2: Hex = '0x6666666666666666666666666666666666666666';
const PAYOUT: Hex = '0x3333333333333333333333333333333333333333';
const OWNER: Hex = '0x4444444444444444444444444444444444444444';
const FEE_RECIP: Hex = '0x5555555555555555555555555555555555555555';
const NAME_HASH: Hex = ('0x' + 'ab'.repeat(32)) as Hex;
const ZERO_NAME_HASH: Hex = ('0x' + '00'.repeat(32)) as Hex;

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

  it('does nothing (no read attempted) when no client is provided', () => {
    const { result } = renderHook(() => useMerchant(ROUTER, 7n, undefined));

    // The effect early-returns: no read is ever in flight, so the initial state stands.
    expect(result.current.merchant).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('normalizes a read failure into a typed error and clears the merchant', async () => {
    const client = makeMockClient({
      reads: {
        merchants: () => {
          throw new Error('network request failed');
        },
      },
    });

    const { result } = renderHook(() => useMerchant(ROUTER, 7n, client));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.code).toBe('UNKNOWN');
    expect(result.current.error?.message).toContain('network request failed');
    expect(result.current.merchant).toBeNull();
  });

  it('cancels the in-flight read when merchantId changes mid-load (no stale write)', async () => {
    // A controllable per-id deferral lets us hold the first read open, swap the id, then resolve
    // the *first* read last and assert its result was discarded (cancelled) in favor of the second.
    const deferred = new Map<bigint, { resolve: (t: unknown) => void }>();
    const client = makeMockClient({
      reads: {
        merchants: (args) =>
          new Promise((resolve) => {
            deferred.set(args.args?.[0] as bigint, { resolve });
          }),
      },
    });

    const { result, rerender } = renderHook(({ id }) => useMerchant(ROUTER, id, client), {
      initialProps: { id: 1n },
    });

    await waitFor(() => expect(deferred.has(1n)).toBe(true));
    expect(result.current.isLoading).toBe(true);

    // Change the id mid-load → the effect cleanup cancels read #1 and starts read #2.
    rerender({ id: 2n });
    await waitFor(() => expect(deferred.has(2n)).toBe(true));

    // Resolve the *stale* read last; its write must be dropped because it was cancelled.
    deferred.get(2n)!.resolve([PAYOUT, OWNER, FEE_RECIP, 50, true, NAME_HASH]);
    await waitFor(() => expect(result.current.merchant?.id).toBe(2n));

    deferred.get(1n)!.resolve([ZERO, ZERO, ZERO, 0, false, ZERO_NAME_HASH]);
    // Give the stale promise a microtask to (not) clobber state.
    await Promise.resolve();
    expect(result.current.merchant?.id).toBe(2n);
    expect(result.current.merchant?.owner).toBe(OWNER);
  });

  it('starts a fresh read when routerAddress changes', async () => {
    const client = makeMockClient({
      reads: {
        merchants: () => [PAYOUT, OWNER, FEE_RECIP, 50, true, NAME_HASH],
      },
    });

    const { result, rerender } = renderHook(({ router }) => useMerchant(router, 7n, client), {
      initialProps: { router: ROUTER },
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(client.readContract).toHaveBeenCalledTimes(1);
    expect(client.readContract.mock.calls[0][0].address).toBe(ROUTER);

    rerender({ router: ROUTER_2 });

    await waitFor(() => expect(client.readContract).toHaveBeenCalledTimes(2));
    expect(client.readContract.mock.calls[1][0].address).toBe(ROUTER_2);
  });
});

describe('isUnregistered', () => {
  const base: MerchantInfo = {
    id: 1n,
    payout: PAYOUT,
    owner: OWNER,
    feeRecipient: FEE_RECIP,
    feeBps: 50,
    active: true,
    nameHash: NAME_HASH,
  };

  it('is true when owner is the zero address', () => {
    expect(isUnregistered({ ...base, owner: ZERO })).toBe(true);
  });

  it('is false when owner is a real address', () => {
    expect(isUnregistered({ ...base, owner: OWNER })).toBe(false);
  });
});

describe('mapMerchantTuple', () => {
  it('coerces feeBps to a number', () => {
    const m = mapMerchantTuple(1n, [PAYOUT, OWNER, FEE_RECIP, 100, true, NAME_HASH]);
    expect(m.feeBps).toBe(100);
    expect(typeof m.feeBps).toBe('number');
  });

  it('maps a max uint16 feeBps value without loss', () => {
    const UINT16_MAX = 65535;
    const m = mapMerchantTuple(1n, [PAYOUT, OWNER, FEE_RECIP, UINT16_MAX, true, NAME_HASH]);
    expect(m.feeBps).toBe(UINT16_MAX);
    expect(typeof m.feeBps).toBe('number');
  });

  it('preserves address casing (checksummed and lowercase pass through verbatim)', () => {
    const CHECKSUMMED: Hex = '0xAbC0000000000000000000000000000000000123';
    const LOWERCASE: Hex = '0xabc0000000000000000000000000000000000123';
    const m = mapMerchantTuple(1n, [CHECKSUMMED, LOWERCASE, FEE_RECIP, 0, true, NAME_HASH]);
    // The mapper is a faithful passthrough — it must not normalize/checksum the casing itself.
    expect(m.payout).toBe(CHECKSUMMED);
    expect(m.owner).toBe(LOWERCASE);
  });

  it('maps all-zero addresses in each field (the unregistered sentinel)', () => {
    const m = mapMerchantTuple(0n, [ZERO, ZERO, ZERO, 0, false, ZERO_NAME_HASH]);
    expect(m.payout).toBe(ZERO);
    expect(m.owner).toBe(ZERO);
    expect(m.feeRecipient).toBe(ZERO);
    expect(m.active).toBe(false);
    expect(m.nameHash).toBe(ZERO_NAME_HASH);
    expect(isUnregistered(m)).toBe(true);
  });
});
