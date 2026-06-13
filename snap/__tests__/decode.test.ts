import { encodeFunctionData, stringToHex, toHex } from 'viem/utils';
import { describe, expect, it } from 'vitest';

import { ROUTER_ABI } from '../src/router/abi';
import {
  decodeOrderIdLabel,
  formatUsd,
  parseRouterCall,
} from '../src/router/decode';

const ARC = 5042002;
const BASE = 84532;

/** Pad a short hex order id to a full bytes32 (right-padded with zeros). */
function toOrderId(text: string): `0x${string}` {
  return stringToHex(text, { size: 32 });
}

describe('parseRouterCall', () => {
  it('decodes payNative calldata into a PaymentSummary with token === null', () => {
    const orderId = toOrderId('order-1');
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'payNative',
      args: [7n, 2900000000n, orderId],
    });
    const summary = parseRouterCall({ data }, ARC);
    expect(summary).not.toBeNull();
    expect(summary?.merchantId).toBe(7n);
    expect(summary?.usdAmount8).toBe(2900000000n);
    expect(summary?.token).toBeNull();
    expect(summary?.orderId).toBe(orderId);
    expect(summary?.chainLabel).toBe('Arc Testnet');
  });

  it('decodes payToken calldata with the ERC-20 token address', () => {
    const token = '0x1111111111111111111111111111111111111111' as const;
    const orderId = toOrderId('order-2');
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'payToken',
      args: [3n, token, 1000000000n, orderId],
    });
    const summary = parseRouterCall({ data }, BASE);
    expect(summary?.token?.toLowerCase()).toBe(token);
    expect(summary?.merchantId).toBe(3n);
    expect(summary?.chainLabel).toBe('Base Sepolia');
  });

  it('treats the native sentinel token (address(0)) as null in payToken', () => {
    const orderId = toOrderId('o');
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'payToken',
      args: [
        1n,
        '0x0000000000000000000000000000000000000000',
        100000000n,
        orderId,
      ],
    });
    const summary = parseRouterCall({ data }, ARC);
    expect(summary?.token).toBeNull();
  });

  it('returns null for calldata that targets a different function', () => {
    // transfer(address,uint256) — not a router pay call.
    const data = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'transfer',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
          stateMutability: 'nonpayable',
        },
      ],
      functionName: 'transfer',
      args: ['0x2222222222222222222222222222222222222222', 1n],
    });
    expect(parseRouterCall({ data }, ARC)).toBeNull();
  });

  it('returns null (no throw) for calldata shorter than 4 bytes', () => {
    expect(parseRouterCall({ data: '0x' }, ARC)).toBeNull();
    expect(parseRouterCall({ data: '0xab' }, ARC)).toBeNull();
    expect(parseRouterCall({ data: null }, ARC)).toBeNull();
    expect(parseRouterCall({}, ARC)).toBeNull();
  });

  it('returns null for a router selector with malformed args (no throw)', () => {
    // payNative selector + truncated args.
    expect(parseRouterCall({ data: '0x8589fa0f0011' }, ARC)).toBeNull();
  });

  it('maps an unknown chain id into the label', () => {
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'payNative',
      args: [1n, 100000000n, toOrderId('x')],
    });
    const summary = parseRouterCall({ data }, 999999);
    expect(summary?.chainLabel).toContain('999999');
  });
});

describe('decodeOrderIdLabel', () => {
  it('decodes a valid UTF-8 order id to its string', () => {
    expect(decodeOrderIdLabel(toOrderId('INV-2026-001'))).toBe('INV-2026-001');
  });

  it('falls back to raw hex for non-UTF-8 bytes', () => {
    // A bytes32 of high random bytes is not printable text.
    const raw = toHex(
      new Uint8Array(32).fill(0xff),
    ) as `0x${string}`;
    expect(decodeOrderIdLabel(raw)).toBe(raw);
  });

  it('falls back to raw hex for an all-zero order id', () => {
    const zero = toHex(new Uint8Array(32)) as `0x${string}`;
    expect(decodeOrderIdLabel(zero)).toBe(zero);
  });
});

describe('formatUsd', () => {
  it('formats 2900000000n as $29.00', () => {
    expect(formatUsd(2900000000n)).toBe('$29.00');
  });

  it('formats 100000000n as $1.00', () => {
    expect(formatUsd(100000000n)).toBe('$1.00');
  });

  it('always shows two decimal places', () => {
    expect(formatUsd(150000000n)).toBe('$1.50');
    expect(formatUsd(105000000n)).toBe('$1.05');
  });

  it('formats zero as $0.00', () => {
    expect(formatUsd(0n)).toBe('$0.00');
  });
});
