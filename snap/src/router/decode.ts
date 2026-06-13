/**
 * Calldata decoding for the insight panel.
 *
 * `parseRouterCall` inspects a pending transaction's `data` field and, if it is
 * a `payNative` or `payToken` call, returns a typed `PaymentSummary`. Every
 * other call (and any malformed calldata) returns `null` so `onTransaction`
 * never throws and never produces a false-positive panel.
 */

import { decodeFunctionData, hexToString, isHex, size, slice } from 'viem/utils';

import { PAY_NATIVE_SELECTOR, PAY_TOKEN_SELECTOR, ROUTER_ABI } from './abi';
import { chainLabel } from './chains';
import type { PaymentSummary } from '../types';

/** The native-coin sentinel address used by the router (`address(0)`). */
const NATIVE_SENTINEL = '0x0000000000000000000000000000000000000000';

/**
 * The subset of a MetaMask `onTransaction` payload `parseRouterCall` reads.
 */
export type DecodableTransaction = {
  /** ABI-encoded calldata. */
  data?: string | null;
  /** Optional value field (unused for decoding but present on the payload). */
  value?: string | null;
};

/**
 * Whether a decoded string contains only printable characters (no ASCII control
 * codes and no DEL). Used to decide whether an order id is human-readable text.
 *
 * @param text - The candidate string.
 * @returns `true` if every codepoint is printable.
 */
function isPrintable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Reject ASCII control codes, DEL, and the U+FFFD replacement character
    // (which `hexToString` emits for bytes that are not valid UTF-8).
    if (code < 0x20 || code === 0x7f || code === 0xfffd) {
      return false;
    }
  }
  return true;
}

/**
 * Best-effort UTF-8 decode of a `bytes32` order id.
 *
 * Trailing zero-padding is stripped first. If the remaining bytes are printable
 * UTF-8, the decoded string is returned; otherwise the raw hex is returned so
 * the panel always shows something truthful (never a mojibake string).
 *
 * @param orderId - The 32-byte order id as hex.
 * @returns A human-readable label: the UTF-8 string, or the raw hex.
 */
export function decodeOrderIdLabel(orderId: `0x${string}`): string {
  // Strip trailing zero bytes (right-padding) before decoding.
  const trimmed = orderId.replace(/(00)+$/u, '') as `0x${string}`;
  if (trimmed === '0x' || trimmed.length <= 2) {
    return orderId;
  }
  try {
    const text = hexToString(trimmed);
    if (text.length > 0 && isPrintable(text)) {
      return text;
    }
  } catch {
    // Fall through to hex.
  }
  return orderId;
}

/**
 * Format an 8-decimal USD amount as a `$0.00` string with exactly two decimals.
 *
 * The merchant's price is exact (8 decimals) — this rounds to cents for display
 * only and never alters the on-chain amount.
 *
 * @param usdAmount8 - USD price scaled by 1e8 (e.g. `2900000000n` === $29.00).
 * @returns A string like `"$29.00"`.
 */
export function formatUsd(usdAmount8: bigint): string {
  const cents = usdAmount8 / 1000000n; // 1e8 / 1e2 = 1e6 per cent
  const dollars = cents / 100n;
  const remainder = cents % 100n;
  const padded = remainder.toString().padStart(2, '0');
  return `$${dollars.toString()}.${padded}`;
}

/**
 * Decode a pending transaction into a `PaymentSummary` if it targets the
 * router's pay functions.
 *
 * @param tx - The transaction payload from `onTransaction` (only `data` is read).
 * @param chainId - Numeric EVM chain id, used for the chain label.
 * @returns A `PaymentSummary`, or `null` if the calldata is not a recognized
 *          router pay call (including short / malformed calldata).
 */
export function parseRouterCall(
  tx: DecodableTransaction,
  chainId: number,
): PaymentSummary | null {
  const data = tx.data;
  if (!data || !isHex(data) || size(data) < 4) {
    return null;
  }

  const selector = slice(data, 0, 4).toLowerCase();
  if (selector !== PAY_NATIVE_SELECTOR && selector !== PAY_TOKEN_SELECTOR) {
    return null;
  }

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ROUTER_ABI, data });
  } catch {
    // Selector matched but args are malformed — treat as not-a-router-call.
    return null;
  }

  const base = { chainId, chainLabel: chainLabel(chainId) };

  if (decoded.functionName === 'payNative') {
    const [merchantId, usdAmount8, orderId] = decoded.args;
    return {
      ...base,
      merchantId,
      usdAmount8,
      token: null,
      tokenAmount: 0n,
      orderId,
      orderIdLabel: decodeOrderIdLabel(orderId),
    };
  }

  if (decoded.functionName === 'payToken') {
    const [merchantId, token, usdAmount8, orderId] = decoded.args;
    return {
      ...base,
      merchantId,
      usdAmount8,
      token: token === NATIVE_SENTINEL ? null : token,
      tokenAmount: 0n,
      orderId,
      orderIdLabel: decodeOrderIdLabel(orderId),
    };
  }

  return null;
}
