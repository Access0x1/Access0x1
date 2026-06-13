/**
 * @file Minimal ABI fragments for the contracts the SDK touches.
 *
 * Deliberately partial: only the functions, events, and custom errors `@access0x1/react` actually
 * calls or decodes are included. Future changes to unrelated router functions must not churn this
 * file. Custom errors are included so viem can decode a revert into a typed, human-readable name.
 *
 * Extracted from the deployed `Access0x1Router` / `Access0x1Lanes` sources — see
 * {@link https://github.com/Access0x1/Access0x1}.
 */

/**
 * The slice of `Access0x1Router` the SDK calls:
 * - `quote(merchantId, token, usdAmount8) → uint256` (view) — USD→token at the in-tx feed price.
 * - `payNative(merchantId, usdAmount8, orderId)` (payable) — same-chain native settlement.
 * - `payToken(merchantId, token, usdAmount8, orderId)` — same-chain ERC-20 settlement.
 * - `merchants(uint256) → Merchant tuple` (the public mapping getter).
 * - `PaymentReceived(...)` — the full event signature so `watchContractEvent` / `decodeEventLog`
 *   decode the receipt correctly.
 * - The router's custom errors, so a revert surfaces as a typed name (e.g. `Access0x1__Underpaid`).
 */
export const ROUTER_ABI = [
  {
    type: 'function',
    name: 'quote',
    stateMutability: 'view',
    inputs: [
      { name: 'merchantId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'usdAmount8', type: 'uint256' },
    ],
    outputs: [{ name: 'tokenAmount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'payNative',
    stateMutability: 'payable',
    inputs: [
      { name: 'merchantId', type: 'uint256' },
      { name: 'usdAmount8', type: 'uint256' },
      { name: 'orderId', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'payToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'merchantId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'usdAmount8', type: 'uint256' },
      { name: 'orderId', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'merchants',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      { name: 'payout', type: 'address' },
      { name: 'owner', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'feeBps', type: 'uint16' },
      { name: 'active', type: 'bool' },
      { name: 'nameHash', type: 'bytes32' },
    ],
  },
  {
    type: 'event',
    name: 'PaymentReceived',
    inputs: [
      { name: 'merchantId', type: 'uint256', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'grossAmount', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
      { name: 'netAmount', type: 'uint256', indexed: false },
      { name: 'usdAmount8', type: 'uint256', indexed: false },
      { name: 'orderId', type: 'bytes32', indexed: false },
      { name: 'srcChainSelector', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
  // ── Typed custom errors (decode-only) ──
  { type: 'error', name: 'Access0x1__MerchantInactive', inputs: [{ name: 'id', type: 'uint256' }] },
  { type: 'error', name: 'Access0x1__MerchantNotFound', inputs: [{ name: 'id', type: 'uint256' }] },
  { type: 'error', name: 'Access0x1__TokenNotAllowed', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'Access0x1__InvalidPrice', inputs: [{ name: 'answer', type: 'int256' }] },
  {
    type: 'error',
    name: 'Access0x1__Underpaid',
    inputs: [
      { name: 'required', type: 'uint256' },
      { name: 'provided', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'Access0x1__FeeOnTransferToken',
    inputs: [
      { name: 'expected', type: 'uint256' },
      { name: 'received', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'Access0x1__ZeroAmount', inputs: [] },
] as const;

/**
 * Standard ERC-20 `allowance` + `approve`, used for the `payToken` approval pre-step.
 *
 * Only the two functions the SDK calls are included; the approval is always set to the exact gross
 * amount (never `MaxUint256`) — minimum necessary approval.
 */
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * The read slice of `Access0x1Lanes` (ERC-6909) used by the optional {@link usePaymentLanes} hook.
 *
 * `laneId(chainSelector, asset, recipient)` is `pure` — the SDK can derive the id locally or read it
 * back; `balanceOf(owner, id)` is the standard ERC-6909 balance getter.
 *
 * Note: `chainSelector` is a `uint64` (CCIP-style selector), matching the deployed contract — NOT a
 * `uint256` chain id.
 */
export const LANES_ABI = [
  {
    type: 'function',
    name: 'laneId',
    stateMutability: 'pure',
    inputs: [
      { name: 'chainSelector', type: 'uint64' },
      { name: 'asset', type: 'address' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
