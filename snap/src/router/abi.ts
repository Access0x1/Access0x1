/**
 * Minimal ABI fragments and event constants the Snap embeds to decode
 * `Access0x1Router` calldata and receipts.
 *
 * The Snap cannot import Foundry artifacts at runtime, so these fragments are
 * copied from the contract source (`src/Access0x1Router.sol`). The selectors
 * and `PAYMENT_RECEIVED_TOPIC0` were computed at build time with `cast` /
 * `keccak256` against the deployed ABI — NEVER transcribed from memory.
 *
 * To regenerate after any signature change, run from the repo root:
 *   cast sig "payNative(uint256,uint256,bytes32)"
 *   cast sig "payToken(uint256,address,uint256,bytes32)"
 *   cast keccak "PaymentReceived(uint256,address,address,uint256,uint256,uint256,uint256,bytes32,uint64)"
 *   cast sig "merchants(uint256)"
 */

import { parseAbi } from 'viem/utils';

/**
 * The two router entry points the insight panel decodes. The ENTIRE ABI is
 * deliberately just these two functions — keeping the bundle tree-shakeable
 * and the attack surface minimal.
 */
export const ROUTER_ABI = parseAbi([
  'function payNative(uint256 merchantId, uint256 usdAmount8, bytes32 orderId) payable',
  'function payToken(uint256 merchantId, address token, uint256 usdAmount8, bytes32 orderId)',
]);

/**
 * The `merchants(uint256)` public getter. The auto-generated getter returns the
 * struct's value-type fields in declaration order:
 * `(payout, owner, feeRecipient, feeBps, active, nameHash)`.
 */
export const MERCHANTS_ABI = parseAbi([
  'function merchants(uint256 id) view returns (address payout, address owner, address feeRecipient, uint16 feeBps, bool active, bytes32 nameHash)',
]);

/**
 * 4-byte selector of `payNative(uint256,uint256,bytes32)`.
 * @warn BOOTH-CONFIRM — verify with `cast sig` against the deployed ABI.
 */
export const PAY_NATIVE_SELECTOR = '0x8589fa0f' as const;

/**
 * 4-byte selector of `payToken(uint256,address,uint256,bytes32)`.
 * @warn BOOTH-CONFIRM — verify with `cast sig` against the deployed ABI.
 */
export const PAY_TOKEN_SELECTOR = '0x004bef62' as const;

/**
 * `keccak256` topic0 of the `PaymentReceived` event.
 *
 * Signature:
 *   PaymentReceived(uint256,address,address,uint256,uint256,uint256,uint256,bytes32,uint64)
 *
 * @warn BOOTH-CONFIRM — recompute with
 *   `cast keccak "PaymentReceived(uint256,address,address,uint256,uint256,uint256,uint256,bytes32,uint64)"`
 *   against the deployed ABI before relying on it; never transcribe from memory.
 */
export const PAYMENT_RECEIVED_TOPIC0 =
  '0x0e7e4f9badfadd9437d5fe53bdba0ca985b1b3414cb35b09a4459416e1735eea' as const;

/**
 * The `PaymentReceived` event fragment, used to decode receipt logs.
 */
export const PAYMENT_RECEIVED_ABI = parseAbi([
  'event PaymentReceived(uint256 indexed merchantId, address indexed buyer, address indexed token, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, uint256 usdAmount8, bytes32 orderId, uint64 srcChainSelector)',
]);
