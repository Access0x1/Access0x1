/**
 * @file Unit tests for the Uniswap v4 hook helpers.
 */

import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from 'viem';
import {
  RECEIPT_HOOK_ABI,
  decodeSwapReceipt,
  encodeReceiptHookData,
  encodeSessionHookData,
  readMemberFee,
} from './uniswapHooks.js';
import { makeMockClient } from './test/mockClient.js';
import type { Hex } from './types.js';

const ORDER: Hex = keccak256(toHex('order-1'));
const SWAPPER: Hex = '0x1111111111111111111111111111111111111111';
const ROUTER: Hex = '0x2222222222222222222222222222222222222222';
const HOOK: Hex = '0x0000000000000000000000000000000000002080';

describe('hook data', () => {
  it('a receipt claim is exactly 64 bytes, merchant id then order', () => {
    const data = encodeReceiptHookData(7n, ORDER);
    expect((data.length - 2) / 2).toBe(64);
    expect(data.slice(2, 66)).toBe(7n.toString(16).padStart(64, '0'));
    expect(data.slice(66)).toBe(ORDER.slice(2));
  });

  it('a session charge is exactly 32 bytes', () => {
    expect((encodeSessionHookData(ORDER).length - 2) / 2).toBe(32);
  });

  it('refuses inputs the hooks would misread', () => {
    expect(() => encodeReceiptHookData(-1n, ORDER)).toThrow(RangeError);
    expect(() => encodeReceiptHookData(1n, '0x1234')).toThrow(RangeError);
    expect(() => encodeSessionHookData('0x1234')).toThrow(RangeError);
  });
});

describe('decodeSwapReceipt', () => {
  const topics = encodeEventTopics({
    abi: RECEIPT_HOOK_ABI,
    eventName: 'SwapReceipt',
    args: { poolId: ORDER, merchantId: 7n, swapper: SWAPPER },
  }) as Hex[];
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }, { type: 'int256' }, { type: 'bool' }],
    [ROUTER, ORDER, -5n, true],
  );

  it('reads every field of a receipt the hook emitted', () => {
    const r = decodeSwapReceipt({ data, topics });
    expect(r).not.toBeNull();
    expect(r!.merchantId).toBe(7n);
    expect(r!.swapper.toLowerCase()).toBe(SWAPPER);
    expect(r!.sender.toLowerCase()).toBe(ROUTER);
    expect(r!.delta).toBe(-5n);
    expect(r!.verified).toBe(true);
  });

  it('returns null for any other event', () => {
    expect(decodeSwapReceipt({ data, topics: [keccak256(toHex('Other()'))] })).toBeNull();
  });
});

describe('readMemberFee', () => {
  it('converts pips to a percent and passes the pool key through', async () => {
    const client = makeMockClient({ reads: { feeFor: () => [500, true] } });
    const key = { currency0: SWAPPER, currency1: ROUTER, fee: 0x800000, tickSpacing: 60, hooks: HOOK };
    const r = await readMemberFee(client, HOOK, key, SWAPPER);
    expect(r).toEqual({ fee: 500, member: true, percent: 0.05 });
    expect(client.readContract.mock.calls[0][0].args).toEqual([key, SWAPPER]);
  });
});
