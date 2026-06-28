/**
 * @file ERC-8213 calldata digest — the always-applicable fallback to ERC-7730 clear signing.
 *
 * Access0x1 ships an {@link https://github.com/ethereum/ERCs | ERC-7730} descriptor
 * (`clear-signing/erc7730-access0x1-router.json`) so a wallet renders **"Pay $29.00 to merchant #7
 * (order 0x…)"** instead of blind hex. ERC-7730 makes the calldata *human-readable* — but it only
 * reaches contracts a wallet has a descriptor for. {@link https://erc8213.eth.limo | ERC-8213} is the
 * weaker-but-universal guarantee: a short, deterministic fingerprint of the exact calldata the buyer is
 * about to sign, so they can cross-verify on a second device that the bytes their wallet shows match
 * the bytes the checkout built. It does not make the data readable (that is ERC-7730's job); it makes
 * it *verifiable*, for every contract, descriptor or not.
 *
 * The digest is defined by ERC-8213 as:
 *
 * ```text
 * keccak256( uint256(len(calldata)) ‖ calldata )
 * ```
 *
 * — a 32-byte big-endian length word prefixed to the raw calldata bytes, then keccak256. `chainId` is
 * intentionally **not** included (the digest commits to the call, not the network), matching the spec.
 *
 * This module is pure (no client, no network): a checkout computes the digest off the same intent it
 * sends to the router, and the buyer compares it to what their wallet/second device shows.
 *
 * @packageDocumentation
 */

import { concat, encodeFunctionData, keccak256, numberToHex, size, type Abi } from 'viem';
import { ROUTER_ABI } from './abi.js';
import { NATIVE_TOKEN, type Hex } from './types.js';

/**
 * Compute the {@link https://erc8213.eth.limo | ERC-8213} calldata digest of arbitrary calldata.
 *
 * The preimage is the 32-byte big-endian byte-length of `calldata` concatenated with the raw calldata,
 * hashed with keccak256 — `keccak256(uint256(len) ‖ calldata)`. The length prefix is what makes the
 * digest unambiguous: two different calls can never collide just because one's bytes are a prefix of
 * the other's. `chainId` is deliberately excluded, so the same call digests identically on every chain.
 *
 * @param calldata The 0x-prefixed transaction calldata (selector + ABI-encoded args) the wallet signs.
 * @returns The 32-byte ERC-8213 digest as a 0x-prefixed hex string.
 *
 * @example
 * ```ts
 * calldataDigest('0x'); // empty calldata → keccak256(32 zero bytes)
 * // 0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563
 * ```
 */
export function calldataDigest(calldata: Hex): Hex {
  // `size` is the byte length of the hex value (e.g. `0x12345678` → 4), NOT the string length.
  const byteLength = size(calldata);
  // 32-byte big-endian uint256 length word, exactly as the spec preimage requires.
  const lengthWord = numberToHex(BigInt(byteLength), { size: 32 });
  return keccak256(concat([lengthWord, calldata]));
}

/**
 * A same-chain Access0x1Router payment intent, in the router's own normalized units.
 *
 * These are the exact values {@link usePayment} sends on-chain, so a digest computed from them matches
 * the calldata the buyer's wallet signs byte-for-byte. The caller normalizes a human price to 8-decimal
 * USD (`$29.00` → `2_900_000_000n`) and a human order reference to a bytes32 (`keccak256`) beforehand —
 * the same conversions {@link usePayment} applies.
 */
export interface PaymentCalldataParams {
  /** The merchant being paid (the id returned by `registerMerchant`). */
  merchantId: bigint;
  /** The USD price in the router's 8-decimal fixed point (`$29.00` = `2_900_000_000n`). */
  usdAmount8: bigint;
  /** The opaque bytes32 order reference (the router echoes it in `PaymentReceived`). */
  orderId: Hex;
  /** The ERC-20 to pay in; omit or pass {@link NATIVE_TOKEN} for a native (`payNative`) payment. */
  token?: Hex;
}

/**
 * Encode the exact `payNative` / `payToken` calldata the SDK would broadcast for a payment intent.
 *
 * Mirrors {@link usePayment}'s settlement call: a native payment encodes
 * `payNative(merchantId, usdAmount8, orderId)`; a token payment encodes
 * `payToken(merchantId, token, usdAmount8, orderId)`. Returned so a checkout can show — or digest — the
 * precise bytes the wallet will sign.
 *
 * @param params The payment intent in normalized router units. See {@link PaymentCalldataParams}.
 * @returns The 0x-prefixed router calldata (selector + ABI-encoded args).
 */
export function encodePaymentCalldata(params: PaymentCalldataParams): Hex {
  const { merchantId, usdAmount8, orderId, token } = params;
  const isNative = token == null || token === NATIVE_TOKEN;
  return isNative
    ? encodeFunctionData({
        abi: ROUTER_ABI as Abi,
        functionName: 'payNative',
        args: [merchantId, usdAmount8, orderId],
      })
    : encodeFunctionData({
        abi: ROUTER_ABI as Abi,
        functionName: 'payToken',
        args: [merchantId, token, usdAmount8, orderId],
      });
}

/**
 * The {@link https://erc8213.eth.limo | ERC-8213} digest of an Access0x1Router payment intent.
 *
 * Convenience over {@link encodePaymentCalldata} + {@link calldataDigest}: the digest a checkout shows
 * the buyer to cross-verify against their wallet. Because it digests the same calldata {@link usePayment}
 * sends, it commits to the merchant, amount, order, and (for a token payment) the token — change any of
 * them and the digest changes.
 *
 * @param params The payment intent in normalized router units. See {@link PaymentCalldataParams}.
 * @returns The 32-byte ERC-8213 digest of the payment calldata.
 */
export function paymentCalldataDigest(params: PaymentCalldataParams): Hex {
  return calldataDigest(encodePaymentCalldata(params));
}
