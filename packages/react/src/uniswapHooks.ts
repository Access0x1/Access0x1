/**
 * @file Uniswap v4 hooks — the client half of Access0x1's three hooks (`hooks/src/` in the repo).
 *
 * - **Receipt hook**: put {@link encodeReceiptHookData} in a swap's `hookData` to claim a merchant and
 *   order; read the result with {@link decodeSwapReceipt}. A receipt's `verified` is true only when the
 *   merchant is active on the Router and the swap came from the merchant's own wallet.
 * - **Member-fee hook**: {@link readMemberFee} says what fee a swapper would pay in a merchant's pool.
 * - **Session-budget hook**: put {@link encodeSessionHookData} in `hookData` to charge a swap against a
 *   SessionGrant budget whose delegate is the hook.
 *
 * Like `<PayButton>`'s router prop, no hook address is baked in: none is deployed yet, and the host
 * passes the address it trusts.
 *
 * @packageDocumentation
 */

import { decodeEventLog, encodeAbiParameters, type Abi } from 'viem';
import type { Access0x1Client } from './client.js';
import type { Hex } from './types.js';

/** A v4 PoolKey as the hooks take it. `fee` is 0x800000 for a dynamic-fee pool. */
export interface PoolKey {
  currency0: Hex;
  currency1: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Hex;
}

/** The receipt hook's event and the two reads/writes a client needs. */
export const RECEIPT_HOOK_ABI = [
  {
    type: 'event',
    name: 'SwapReceipt',
    inputs: [
      { name: 'poolId', type: 'bytes32', indexed: true },
      { name: 'merchantId', type: 'uint256', indexed: true },
      { name: 'swapper', type: 'address', indexed: true },
      { name: 'sender', type: 'address', indexed: false },
      { name: 'orderRef', type: 'bytes32', indexed: false },
      { name: 'delta', type: 'int256', indexed: false },
      { name: 'verified', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'setRouterTrust',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'merchantId', type: 'uint256' },
      { name: 'router', type: 'address' },
      { name: 'trusted', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'trustedRouter',
    stateMutability: 'view',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

/** The member-fee hook's read and the merchant's configuration call. */
export const MEMBER_FEE_HOOK_ABI = [
  {
    type: 'function',
    name: 'feeFor',
    stateMutability: 'view',
    inputs: [
      { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS },
      { name: 'swapper', type: 'address' },
    ],
    outputs: [
      { name: 'fee', type: 'uint24' },
      { name: 'member', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'configure',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS },
      { name: 'merchantId', type: 'uint256' },
      { name: 'membership', type: 'address' },
      { name: 'tierId', type: 'uint256' },
      { name: 'memberFee', type: 'uint24' },
      { name: 'publicFee', type: 'uint24' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/** The session-budget hook's one write: trust a router to report you. */
export const SESSION_BUDGET_HOOK_ABI = [
  {
    type: 'function',
    name: 'setRouterTrust',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'router', type: 'address' },
      { name: 'trusted', type: 'bool' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/** v4's dynamic-fee marker for `PoolKey.fee`. */
export const DYNAMIC_FEE_FLAG = 0x800000;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Hook data claiming `merchantId` and `orderRef` for the receipt hook: exactly 64 bytes. Any other
 * length is read by the hook as no claim.
 */
export function encodeReceiptHookData(merchantId: bigint, orderRef: Hex): Hex {
  if (merchantId < 0n) throw new RangeError('merchantId must be non-negative');
  if (!BYTES32.test(orderRef)) throw new RangeError('orderRef must be 32 bytes (0x + 64 hex)');
  return encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [merchantId, orderRef]);
}

/** Hook data charging a swap to a SessionGrant session: exactly 32 bytes, the session id. */
export function encodeSessionHookData(sessionId: Hex): Hex {
  if (!BYTES32.test(sessionId)) throw new RangeError('sessionId must be 32 bytes (0x + 64 hex)');
  return sessionId.toLowerCase() as Hex;
}

/** A decoded `SwapReceipt`. */
export interface SwapReceipt {
  poolId: Hex;
  merchantId: bigint;
  swapper: Hex;
  sender: Hex;
  orderRef: Hex;
  delta: bigint;
  verified: boolean;
}

/**
 * Decode a raw log as a `SwapReceipt`, or return `null` if it is some other event. Check the log's
 * `address` is the hook you trust before believing it: anyone can emit an event with this shape.
 */
export function decodeSwapReceipt(log: { data: Hex; topics: readonly Hex[] }): SwapReceipt | null {
  try {
    const { eventName, args } = decodeEventLog({
      abi: RECEIPT_HOOK_ABI,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    if (eventName !== 'SwapReceipt') return null;
    return args as unknown as SwapReceipt;
  } catch {
    return null;
  }
}

/** What `swapper` would pay in a member-fee pool now. `fee` is in pips: 1_000_000 = 100%. */
export async function readMemberFee(
  client: Access0x1Client,
  hook: Hex,
  key: PoolKey,
  swapper: Hex,
): Promise<{ fee: number; member: boolean; percent: number }> {
  const [fee, member] = await client.readContract<readonly [number, boolean]>({
    address: hook,
    abi: MEMBER_FEE_HOOK_ABI,
    functionName: 'feeFor',
    args: [key, swapper],
  });
  return { fee: Number(fee), member, percent: Number(fee) / 10_000 };
}
