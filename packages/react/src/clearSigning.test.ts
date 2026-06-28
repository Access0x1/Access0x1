/**
 * @file Tests for the ERC-8213 calldata digest helpers.
 *
 * The two known-answer vectors are computed independently with Foundry's `cast keccak` (a different
 * keccak implementation than viem's), so a passing test proves the digest matches a second tool — not
 * just that the code agrees with itself.
 */

import { describe, it, expect } from 'vitest';
import { encodeFunctionData, type Abi } from 'viem';
import {
  calldataDigest,
  encodePaymentCalldata,
  paymentCalldataDigest,
  type PaymentCalldataParams,
} from './clearSigning.js';
import { ROUTER_ABI } from './abi.js';
import { NATIVE_TOKEN, type Hex } from './types.js';

// `cast keccak 0x0000…0000` (32 zero bytes) — the digest of empty calldata (len=0 ‖ nothing).
const DIGEST_EMPTY = '0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563';
// `cast keccak 0x000…0004 12345678` — the digest of the 4-byte calldata `0x12345678`.
const DIGEST_12345678 = '0xbca53a900ee1cecffba8d1933d6c15917fb88cfd4043fde14e01d1bcf03d38d4';

describe('calldataDigest (ERC-8213)', () => {
  it('matches a Foundry cast-computed digest for empty calldata', () => {
    // len = 0 → a 32-byte zero word, then keccak256. The canonical keccak256(bytes32(0)).
    expect(calldataDigest('0x')).toBe(DIGEST_EMPTY);
  });

  it('matches a Foundry cast-computed digest for non-empty calldata', () => {
    // len = 4 → 0x…0004 ‖ 0x12345678, then keccak256.
    expect(calldataDigest('0x12345678')).toBe(DIGEST_12345678);
  });

  it('is deterministic', () => {
    expect(calldataDigest('0xdeadbeef')).toBe(calldataDigest('0xdeadbeef'));
  });

  it('changes when a single calldata byte changes (commits to the exact bytes)', () => {
    expect(calldataDigest('0xdeadbeef')).not.toBe(calldataDigest('0xdeadbeff'));
  });

  it('the length prefix disambiguates a prefix collision', () => {
    // `0x00` and `0x0000` share no bytes once the (differing) length word is prepended, so the
    // digests must differ — this is exactly what the uint256(len) prefix exists to guarantee.
    expect(calldataDigest('0x00')).not.toBe(calldataDigest('0x0000'));
  });
});

describe('encodePaymentCalldata + paymentCalldataDigest', () => {
  const base: PaymentCalldataParams = {
    merchantId: 7n,
    usdAmount8: 2_900_000_000n, // $29.00
    orderId: `0x${'11'.repeat(32)}` as Hex,
  };

  it('native: digests the exact payNative calldata a wallet would sign', () => {
    const calldata = encodeFunctionData({
      abi: ROUTER_ABI as Abi,
      functionName: 'payNative',
      args: [base.merchantId, base.usdAmount8, base.orderId],
    }) as Hex;
    expect(encodePaymentCalldata(base)).toBe(calldata);
    expect(paymentCalldataDigest(base)).toBe(calldataDigest(calldata));
  });

  it('token: routes to payToken (token arg encoded) and differs from the native digest', () => {
    const token = `0x${'22'.repeat(20)}` as Hex;
    const calldata = encodeFunctionData({
      abi: ROUTER_ABI as Abi,
      functionName: 'payToken',
      args: [base.merchantId, token, base.usdAmount8, base.orderId],
    }) as Hex;
    expect(encodePaymentCalldata({ ...base, token })).toBe(calldata);
    expect(paymentCalldataDigest({ ...base, token })).toBe(calldataDigest(calldata));
    expect(paymentCalldataDigest({ ...base, token })).not.toBe(paymentCalldataDigest(base));
  });

  it('the NATIVE_TOKEN sentinel is identical to omitting the token (both → payNative)', () => {
    expect(paymentCalldataDigest({ ...base, token: NATIVE_TOKEN })).toBe(paymentCalldataDigest(base));
  });

  it('binds the intent: a different merchant, amount, or order yields a different digest', () => {
    expect(paymentCalldataDigest({ ...base, merchantId: 8n })).not.toBe(paymentCalldataDigest(base));
    expect(paymentCalldataDigest({ ...base, usdAmount8: 1n })).not.toBe(paymentCalldataDigest(base));
    expect(paymentCalldataDigest({ ...base, orderId: `0x${'33'.repeat(32)}` as Hex })).not.toBe(
      paymentCalldataDigest(base),
    );
  });
});
