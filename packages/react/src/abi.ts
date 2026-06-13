/**
 * @file Minimal ABI fragments for the contracts the SDK touches.
 *
 * Deliberately partial: only the functions, events, and custom errors `@access0x1/react` actually
 * calls or decodes are included. Future changes to unrelated router functions must not churn this
 * file. Custom errors are included so viem can decode a revert into a typed, human-readable name.
 *
 * The fragments here are a STRICT SUBSET of the canonical full router ABI in `web/lib/contracts.ts`
 * (the web app's single source of truth, which adds `registerMerchant`, `platformFeeBps`,
 * `tokenAllowed`, the `MerchantRegistered` event, and the registration-only errors the SDK does not
 * call). The two packages publish independently with no build-time link, so this copy is kept in
 * lockstep by hand. Argument names, types, and ordering MUST match the on-chain ABI exactly so the
 * UI and the SDK decode every revert and event identically.
 *
 * Extracted from the deployed `Access0x1Router` / `PaymentLanes` sources — see
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
    // On-chain the first param is unnamed: `quote(uint256, address token, uint256 usdAmount8)`.
    inputs: [
      { name: '', type: 'uint256' },
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
    // Auto-generated public-mapping getter: the key param is unnamed on-chain.
    inputs: [{ name: '', type: 'uint256' }],
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
 * The read slice of `PaymentLanes` (ERC-6909) used by the optional {@link usePaymentLanes} hook.
 *
 * `laneId(chainId, asset, recipient)` is `pure` — the SDK reads it back from the contract;
 * `balanceOf(owner, id)` is the standard ERC-6909 balance getter.
 *
 * Note: `chainId` is a `uint256` (the EVM chain id, e.g. `block.chainid` at credit time), matching
 * the deployed `PaymentLanes.laneId` signature exactly — NOT a `uint64` CCIP-style selector. The id
 * is `uint256(keccak256(abi.encode(chainId, asset, recipient)))`; mismatching the type or order here
 * yields a different id than the router credited, so `balanceOf` would read 0.
 */
export const LANES_ABI = [
  {
    type: 'function',
    name: 'laneId',
    stateMutability: 'pure',
    inputs: [
      { name: 'chainId', type: 'uint256' },
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
