import {
  erc20Abi,
  parseEventLogs,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem'

/**
 * Access0x1Router ABI fragments.
 *
 * Derived from `src/Access0x1Router.sol` (sha `6855eb5` on main) — the spec
 * permits inlining only the fragments the frontend consumes rather than the
 * full forge artifact (`out/` is gitignored). These signatures MUST stay in
 * lockstep with the contract; if the contract changes, regenerate from
 * `forge inspect Access0x1Router abi`.
 *
 * Revert cases the UI must surface (matched by name in `CheckoutCard.humanizeRevert`):
 *   - Access0x1__MerchantNotFound(uint256)
 *   - Access0x1__MerchantInactive(uint256)
 *   - Access0x1__TokenNotAllowed(address)
 *   - Access0x1__Underpaid(uint256,uint256)
 *   - Access0x1__InvalidPrice(int256)
 *   - Access0x1__FeeOnTransferToken(uint256,uint256)
 *   - Access0x1__ZeroAmount()
 *   - OracleLib__StalePrice()   (bubbles up through quote())
 */
export const ROUTER_ABI = [
  // --- reads ---
  {
    type: 'function',
    name: 'merchants',
    stateMutability: 'view',
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
    type: 'function',
    name: 'quote',
    stateMutability: 'view',
    inputs: [
      { name: '', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'usdAmount8', type: 'uint256' },
    ],
    outputs: [{ name: 'tokenAmount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'platformFeeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'tokenAllowed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  // --- writes ---
  {
    type: 'function',
    name: 'registerMerchant',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payout', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'feeBps', type: 'uint16' },
      { name: 'nameHash', type: 'bytes32' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
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
    name: 'payNative',
    stateMutability: 'payable',
    inputs: [
      { name: 'merchantId', type: 'uint256' },
      { name: 'usdAmount8', type: 'uint256' },
      { name: 'orderId', type: 'bytes32' },
    ],
    outputs: [],
  },
  // --- events ---
  {
    type: 'event',
    name: 'MerchantRegistered',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'payout', type: 'address', indexed: false },
      { name: 'feeRecipient', type: 'address', indexed: false },
      { name: 'feeBps', type: 'uint16', indexed: false },
      { name: 'nameHash', type: 'bytes32', indexed: false },
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
  },
  // --- custom errors (for revert decoding) ---
  { type: 'error', name: 'Access0x1__ZeroAddress', inputs: [] },
  {
    type: 'error',
    name: 'Access0x1__FeeTooHigh',
    inputs: [
      { name: 'requested', type: 'uint256' },
      { name: 'max', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'Access0x1__NotMerchantOwner',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'caller', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'Access0x1__MerchantInactive',
    inputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'Access0x1__MerchantNotFound',
    inputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'Access0x1__TokenNotAllowed',
    inputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'error',
    name: 'Access0x1__InvalidPrice',
    inputs: [{ name: 'answer', type: 'int256' }],
  },
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
  // OracleLib error bubbles through quote()/pay paths:
  { type: 'error', name: 'OracleLib__StalePrice', inputs: [] },
] as const

/** The native-token sentinel: address(0) means the chain's native coin. */
export const NATIVE_TOKEN: Address = '0x0000000000000000000000000000000000000000'

/** A decoded merchant record from `merchants(merchantId)`. */
export interface Merchant {
  payout: Address
  owner: Address
  feeRecipient: Address
  feeBps: number
  active: boolean
  nameHash: `0x${string}`
}

/** A decoded `PaymentReceived` event. All token amounts are in the token's own decimals. */
export interface PaymentReceivedEvent {
  merchantId: bigint
  buyer: Address
  token: Address
  grossAmount: bigint
  feeAmount: bigint
  netAmount: bigint
  usdAmount8: bigint
  orderId: `0x${string}`
  srcChainSelector: bigint
}

/**
 * Read a merchant record. Calls `merchants(merchantId)` on the router.
 * @throws if the merchant was never registered (owner is the zero address —
 *   callers should treat `owner === 0x0` as "not found").
 */
export async function getMerchant(
  client: PublicClient,
  routerAddress: Address,
  merchantId: bigint,
): Promise<Merchant> {
  const [payout, owner, feeRecipient, feeBps, active, nameHash] = await client.readContract({
    address: routerAddress,
    abi: ROUTER_ABI,
    functionName: 'merchants',
    args: [merchantId],
  })
  return { payout, owner, feeRecipient, feeBps, active, nameHash }
}

/**
 * Convert a USD amount (8 decimals) to the token amount required, reading the
 * Chainlink feed through the router's staleness guard. Calls `quote()`.
 *
 * @throws Access0x1__TokenNotAllowed if `token` is not allowlisted or has no feed.
 * @throws OracleLib__StalePrice if the feed round is stale (UI must show "price
 *   feed stale" and disable pay — never a silent wrong amount, law #4).
 */
export async function getQuote(
  client: PublicClient,
  routerAddress: Address,
  merchantId: bigint,
  token: Address,
  usdAmount8: bigint,
): Promise<bigint> {
  return client.readContract({
    address: routerAddress,
    abi: ROUTER_ABI,
    functionName: 'quote',
    args: [merchantId, token, usdAmount8],
  })
}

/** Read the current platform fee (bps). Used to honestly render "0% fee" only when true. */
export async function getPlatformFeeBps(
  client: PublicClient,
  routerAddress: Address,
): Promise<number> {
  return client.readContract({
    address: routerAddress,
    abi: ROUTER_ABI,
    functionName: 'platformFeeBps',
  })
}

/**
 * Register a merchant. Calls `registerMerchant(payout, feeRecipient, feeBps,
 * nameHash)` and parses the `MerchantRegistered` event for the new id.
 *
 * Zero custody: this only writes the registry; no funds move.
 * @throws Access0x1__ZeroAddress (payout is 0x0) / Access0x1__FeeTooHigh.
 */
export async function registerMerchant(
  walletClient: WalletClient,
  publicClient: PublicClient,
  routerAddress: Address,
  args: {
    payout: Address
    feeRecipient: Address
    feeBps: number
    nameHash: `0x${string}`
  },
): Promise<{ txHash: Hash; merchantId: bigint }> {
  const account = walletClient.account
  if (!account) throw new Error('Wallet has no account connected')

  const txHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: routerAddress,
    abi: ROUTER_ABI,
    functionName: 'registerMerchant',
    args: [args.payout, args.feeRecipient, args.feeBps, args.nameHash],
  })

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  const logs = parseEventLogs({
    abi: ROUTER_ABI,
    eventName: 'MerchantRegistered',
    logs: receipt.logs,
  })
  const merchantId = logs[0]?.args.id
  if (merchantId === undefined) {
    throw new Error('registerMerchant: MerchantRegistered event not found in receipt')
  }
  return { txHash, merchantId }
}

/**
 * Pay a merchant in an allowlisted ERC-20 (USDC), priced in USD.
 *
 * Approves EXACTLY the quoted `tokenAmount` (gas-tight; never MaxUint256 —
 * guardrail #6), only when the current allowance is insufficient, then calls
 * `payToken(merchantId, token, usdAmount8, orderId)`. Parses `PaymentReceived`.
 *
 * Off-CEI: this never triggers a swap/bridge — it pays and returns (guardrail #4).
 * @throws Access0x1__MerchantInactive / Access0x1__TokenNotAllowed /
 *   Access0x1__Underpaid / OracleLib__StalePrice (surfaced by name in the UI).
 */
export async function payToken(
  walletClient: WalletClient,
  publicClient: PublicClient,
  routerAddress: Address,
  usdcAddress: Address,
  args: {
    merchantId: bigint
    usdAmount8: bigint
    orderId: `0x${string}`
  },
): Promise<{ txHash: Hash; receipt: PaymentReceivedEvent }> {
  const account = walletClient.account
  if (!account) throw new Error('Wallet has no account connected')

  // Quote fresh in-line so the approve covers the exact required amount.
  const tokenAmount = await getQuote(
    publicClient,
    routerAddress,
    args.merchantId,
    usdcAddress,
    args.usdAmount8,
  )

  // Only re-approve when the existing allowance is short (gas-tight).
  const allowance = await publicClient.readContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, routerAddress],
  })
  if (allowance < tokenAmount) {
    const approveHash = await walletClient.writeContract({
      account,
      chain: walletClient.chain,
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [routerAddress, tokenAmount],
    })
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
  }

  const txHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: routerAddress,
    abi: ROUTER_ABI,
    functionName: 'payToken',
    args: [args.merchantId, usdcAddress, args.usdAmount8, args.orderId],
  })

  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  return { txHash, receipt: parsePaymentReceived(txReceipt.logs) }
}

/**
 * Pay a merchant in the chain's native token, priced in USD. Sends `value`
 * (the caller pre-quotes via {@link getQuote} with `NATIVE_TOKEN`); the router
 * refunds any excess in the same tx. Calls `payNative(merchantId, usdAmount8,
 * orderId)`. Parses `PaymentReceived`.
 */
export async function payNative(
  walletClient: WalletClient,
  publicClient: PublicClient,
  routerAddress: Address,
  args: {
    merchantId: bigint
    usdAmount8: bigint
    orderId: `0x${string}`
    value: bigint
  },
): Promise<{ txHash: Hash; receipt: PaymentReceivedEvent }> {
  const account = walletClient.account
  if (!account) throw new Error('Wallet has no account connected')

  const txHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: routerAddress,
    abi: ROUTER_ABI,
    functionName: 'payNative',
    args: [args.merchantId, args.usdAmount8, args.orderId],
    value: args.value,
  })

  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  return { txHash, receipt: parsePaymentReceived(txReceipt.logs) }
}

/** Parse the first `PaymentReceived` event from a receipt's logs. */
export function parsePaymentReceived(
  logs: readonly { data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]] | [] }[],
): PaymentReceivedEvent {
  const parsed = parseEventLogs({
    abi: ROUTER_ABI,
    eventName: 'PaymentReceived',
    // viem's Log shape is compatible; cast keeps the helper usable from a raw receipt.
    logs: logs as never,
  })
  const ev = parsed[0]
  if (!ev) throw new Error('payment: PaymentReceived event not found in receipt')
  return ev.args as PaymentReceivedEvent
}
