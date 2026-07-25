/**
 * capture-payout-swap.mts — drive ONE real payout-swap through the wired Uniswap Trading
 * API rail, END TO END, and print the landed tx hash.
 *
 * This is the operator-run capture step for the "Receive In Any Coin" payout leg. It uses the
 * EXACT production wiring: `buildPayoutSwapDeps()` reads the same server env the
 * `/api/payout-swap` route reads, `selectPayoutSwapClient(chainId, deps)` picks the Trading
 * API rail, and `runPayoutSwap()` runs quote → slippage-floor → execute. The rail returns the
 * `/swap` READY-TO-SIGN transaction (live-verified shape, 2026-07-25) — this script then
 * completes the loop the way a merchant wallet would: it signs and broadcasts the approval
 * (when `/check_approval` says one is needed) and the swap tx with the burner key, waits for
 * the receipt, and prints the explorer link. A green run is proof the shipped rail works
 * end-to-end against the live endpoint — nothing bespoke is re-implemented here.
 *
 * CHAIN: defaults to **Ethereum Sepolia (11155111)** — the app's home chain, and the one
 * testnet where the Trading API returned a real priced quote when probed (Base Sepolia
 * answered "No quotes available" the same day). Override with `CAPTURE_CHAIN_ID=84532`.
 *
 * Non-custodial framing: the burner IS the merchant/swapper — its key stays in this process,
 * signs only its own transactions, and is never logged.
 *
 * REQUIRED env (a missing var throws a named error listing exactly what is absent — no silent
 * fallback, never a hardcoded key):
 *   UNISWAP_TRADING_API_URL  — Trading API base URL. Absent ⇒ the rail is dormant.
 *   UNISWAP_TRADING_API_KEY  — Trading API `x-api-key` (server-only).
 *   SELLER_PRIVATE_KEY       — funded burner EOA on the capture chain (gas + the input USDC).
 *   CAPTURE_USDC_ADDRESS     — the settled-USDC token address on the capture chain (swap input).
 *   CAPTURE_PAYOUT_TOKEN     — the merchant's payout token address (swap output).
 * OPTIONAL env (documented defaults):
 *   CAPTURE_CHAIN_ID         — capture chain id. Default "11155111" (Ethereum Sepolia).
 *   CAPTURE_RPC_URL          — RPC to broadcast through. Default: the chain's public default.
 *   CAPTURE_AMOUNT_USDC      — settled USDC to swap, ATOMIC base units. Default "1000000" (1 USDC).
 *   CAPTURE_MIN_AMOUNT_OUT   — slippage floor, ATOMIC in the payout token's decimals. Default "0".
 *
 * RUN (from `web/`):
 *   npm run capture:swap
 *
 * On success it prints the landed swap tx hash + the chain's explorer link. A skipped or
 * failed swap prints the worker's reason + detail and exits non-zero — the rail never throws
 * across the settlement boundary, so this script surfaces the outcome instead of masking it.
 */
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia, sepolia } from 'viem/chains'

import { buildPayoutSwapDeps } from '../lib/payout-swap/deps-from-env.js'
import {
  runPayoutSwap,
  selectPayoutSwapClient,
  type SwapRequest,
} from '../lib/payout-swap/index.js'
import type { UnsignedSwapTx } from '../lib/payout-swap/types.js'
import { loadLocalEnv } from './load-local-env.mts'

/** The env this capture requires, checked as a set so one throw lists every gap. */
const REQUIRED_ENV = [
  'UNISWAP_TRADING_API_URL',
  'UNISWAP_TRADING_API_KEY',
  'SELLER_PRIVATE_KEY',
  'CAPTURE_USDC_ADDRESS',
  'CAPTURE_PAYOUT_TOKEN',
] as const

/** Default settled-USDC amount to swap when `CAPTURE_AMOUNT_USDC` is unset (1 USDC, 6 decimals). */
const DEFAULT_AMOUNT_USDC = 1_000_000n
/** Default slippage floor when `CAPTURE_MIN_AMOUNT_OUT` is unset (0 ⇒ any non-reverting quote passes). */
const DEFAULT_MIN_AMOUNT_OUT = 0n

/**
 * The chains this capture can target — exactly the testnets the Trading API rail is mapped
 * to in `capabilities.ts`, with each chain's canonical explorer. Ethereum Sepolia first: it
 * is the app's home chain and the live-verified one.
 */
const CAPTURE_CHAINS: ReadonlyMap<number, { chain: Chain; explorer: string }> = new Map([
  [sepolia.id, { chain: sepolia, explorer: 'https://sepolia.etherscan.io' }],
  [baseSepolia.id, { chain: baseSepolia, explorer: 'https://sepolia.basescan.org' }],
])

/** Thrown when required capture env is missing — carries every missing NAME, never a value. */
class MissingCaptureEnvError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `capture-payout-swap: missing required env: ${missing.join(', ')}. ` +
        `Set each one (SELLER_PRIVATE_KEY is a funded testnet burner — never hardcode a key).`,
    )
    this.name = 'MissingCaptureEnvError'
  }
}

/** Thrown when a supplied env value is present but malformed (address / key / amount / chain). */
class InvalidCaptureEnvError extends Error {
  constructor(message: string) {
    super(`capture-payout-swap: ${message}`)
    this.name = 'InvalidCaptureEnvError'
  }
}

/** Read a trimmed env var, or '' when unset — the single env accessor for this script. */
function env(name: string): string {
  return (process.env[name] ?? '').trim()
}

/** Validate + normalize a 0x-prefixed 32-byte hex private key WITHOUT logging its value. */
function requirePrivateKey(raw: string): Hex {
  const key = raw.startsWith('0x') ? raw : `0x${raw}`
  const wellFormed = /^0x[0-9a-fA-F]{64}$/.test(key)
  if (!wellFormed) {
    throw new InvalidCaptureEnvError('SELLER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key')
  }
  return key as Hex
}

/** Validate an EVM address from env, naming the offending var on failure. */
function requireAddress(name: string, raw: string): Address {
  try {
    return getAddress(raw)
  } catch {
    throw new InvalidCaptureEnvError(`${name} must be a valid EVM address, got "${raw}"`)
  }
}

/** Parse an atomic (base-unit) integer amount from env; empty ⇒ the fallback; guards negatives/garbage. */
function atomicAmount(name: string, raw: string, fallback: bigint): bigint {
  if (raw === '') return fallback
  let value: bigint
  try {
    value = BigInt(raw)
  } catch {
    throw new InvalidCaptureEnvError(`${name} must be an integer in atomic base units, got "${raw}"`)
  }
  if (value < 0n) {
    throw new InvalidCaptureEnvError(`${name} must be non-negative, got "${raw}"`)
  }
  return value
}

/** Resolve the capture chain from env (default: Ethereum Sepolia, the live-verified home chain). */
function resolveChain(): { chain: Chain; explorer: string } {
  const raw = env('CAPTURE_CHAIN_ID')
  const id = raw === '' ? sepolia.id : Number(raw)
  const entry = CAPTURE_CHAINS.get(id)
  if (!entry) {
    const known = [...CAPTURE_CHAINS.keys()].join(', ')
    throw new InvalidCaptureEnvError(`CAPTURE_CHAIN_ID must be one of {${known}}, got "${raw}"`)
  }
  return entry
}

/** Build the swap request from validated env + the derived merchant address. */
function buildRequest(chainId: number, merchant: Address): SwapRequest {
  return {
    chainId,
    usdc: requireAddress('CAPTURE_USDC_ADDRESS', env('CAPTURE_USDC_ADDRESS')),
    payoutToken: requireAddress('CAPTURE_PAYOUT_TOKEN', env('CAPTURE_PAYOUT_TOKEN')),
    merchant,
    amountUsdc: atomicAmount('CAPTURE_AMOUNT_USDC', env('CAPTURE_AMOUNT_USDC'), DEFAULT_AMOUNT_USDC),
    minAmountOut: atomicAmount('CAPTURE_MIN_AMOUNT_OUT', env('CAPTURE_MIN_AMOUNT_OUT'), DEFAULT_MIN_AMOUNT_OUT),
  }
}

/** Sign + broadcast one prepared tx with the burner and wait for its receipt. */
async function signAndLand(
  label: string,
  tx: { to: string; data: string; value?: string },
  wallet: ReturnType<typeof createWalletClient>,
  reader: ReturnType<typeof createPublicClient>,
): Promise<Hex> {
  const hash = await wallet.sendTransaction({
    account: wallet.account!,
    chain: wallet.chain,
    to: getAddress(tx.to),
    data: tx.data as Hex,
    value: tx.value ? BigInt(tx.value) : 0n,
  })
  console.log(`${label} broadcast: ${hash} — waiting for the receipt…`)
  const receipt = await reader.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error(`${label} tx ${hash} reverted on-chain`)
  }
  return hash
}

/**
 * Capture one real payout-swap: validate env, wire the rail, run it, then complete the
 * merchant-wallet leg (approval + the ready-to-sign swap) with the burner and print the tx.
 */
async function main(): Promise<void> {
  // Standalone scripts read only process.env — pull in web/.env.local first (a var
  // exported in the shell still wins), same as mvp-presentation + fund-gateway.
  loadLocalEnv()

  // Fail-fast: check the whole required set at once so the error lists every gap, not just the first.
  const missing = REQUIRED_ENV.filter((name) => env(name) === '')
  if (missing.length > 0) throw new MissingCaptureEnvError(missing)

  const { chain, explorer } = resolveChain()

  // Derive the merchant/swapper ADDRESS from the funded burner key; the key itself is never logged.
  const account = privateKeyToAccount(requirePrivateKey(env('SELLER_PRIVATE_KEY')))
  const req = buildRequest(chain.id, account.address)

  // Exact production wiring: env → deps → the rail client for the capture chain.
  const deps = buildPayoutSwapDeps()
  const client = selectPayoutSwapClient(chain.id, deps)
  if (!client) {
    throw new InvalidCaptureEnvError(
      `${chain.name} resolved no payout-swap rail — check UNISWAP_TRADING_API_URL`,
    )
  }

  const rpc = env('CAPTURE_RPC_URL') || chain.rpcUrls.default.http[0]
  const wallet = createWalletClient({ account, chain, transport: http(rpc) })
  const reader = createPublicClient({ chain, transport: http(rpc) })

  console.log(`Swapper (merchant): ${account.address} on ${chain.name}`)

  // Pre-flight: prove the burner actually HOLDS the input before touching the chain.
  // Without this, an unfunded burner still lands the (pointless) approval, then buys a
  // Universal-Router revert with real gas — the exact failure the first live run hit.
  const usdcBalance = (await reader.readContract({
    address: req.usdc,
    abi: [
      {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ name: 'owner', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
      },
    ],
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint
  if (usdcBalance < req.amountUsdc) {
    throw new InvalidCaptureEnvError(
      `burner ${account.address} holds ${usdcBalance} of ${req.usdc} but the swap needs ` +
        `${req.amountUsdc} — fund it first (no tx was sent, no gas spent)`,
    )
  }

  // Approval pre-step, exactly as a merchant wallet would run it: ask the rail, sign what it hands back.
  if (client.checkApproval) {
    const check = await client.checkApproval(req)
    if (check.needed && check.approval) {
      await signAndLand('approval', check.approval, wallet, reader)
    } else {
      console.log('approval: not needed (already approved)')
    }
  }

  console.log(
    `Swapping ${req.amountUsdc} USDC base units -> ${req.payoutToken} (floor ${req.minAmountOut})…`,
  )
  const result = await runPayoutSwap(req, client)

  if (!result.swapped) {
    console.error(
      `payout-swap did not execute: ${result.reason}` +
        (result.detail ? ` — ${result.detail}` : ''),
    )
    process.exitCode = 1
    return
  }

  // Two honest endings: a rail that submitted (txHash) or one that prepared (unsignedTx) —
  // the Trading API does the latter; the burner completes it the way the merchant wallet would.
  let landed: Hex
  if (result.txHash) {
    landed = result.txHash as Hex
  } else if (result.unsignedTx) {
    landed = await signAndLand('swap', result.unsignedTx as UnsignedSwapTx, wallet, reader)
  } else {
    throw new Error('rail reported swapped without a txHash or an unsignedTx — wiring bug')
  }

  console.log(`Swapped via ${result.rail}. quoted amountOut=${result.amountOut}`)
  console.log(`tx: ${landed}`)
  console.log(`${explorer}/tx/${landed}`)
}

// Run only when invoked directly (never when imported by a test).
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /capture-payout-swap\.mts$/.test(process.argv[1])

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('capture-payout-swap failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
