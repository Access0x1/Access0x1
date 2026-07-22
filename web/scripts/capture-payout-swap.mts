/**
 * capture-payout-swap.mts — drive ONE real Base-Sepolia payout-swap through the wired
 * Uniswap Trading API rail and print the resulting tx hash.
 *
 * This is the operator-run capture step for the "Receive In Any Coin" payout leg. It uses the
 * EXACT production wiring: `buildPayoutSwapDeps()` reads the same server env the
 * `/api/payout-swap` route reads, `selectPayoutSwapClient(baseSepolia.id, deps)` picks the Base
 * rail (`createUniswapTradingApiClient`), and `runPayoutSwap()` runs quote → slippage-floor →
 * gasless UniswapX `/order`. A green run is therefore proof the shipped rail works end-to-end
 * against a live endpoint — nothing bespoke is re-implemented here.
 *
 * Non-custodial: the merchant/seller wallet is the swapper. The script derives that wallet's
 * ADDRESS from a funded burner key (env, never hardcoded) and passes it as the `merchant` of the
 * swap request; the key never leaves this process and is never logged.
 *
 * REQUIRED env (a missing var throws a named error listing exactly what is absent — no silent
 * fallback, never a hardcoded key):
 *   UNISWAP_TRADING_API_URL  — Trading API base URL (the Base rail base). Absent ⇒ the rail is dormant.
 *   UNISWAP_TRADING_API_KEY  — Trading API `x-api-key` (server-only).
 *   SELLER_PRIVATE_KEY       — funded Base-Sepolia burner EOA (the merchant/swapper); 0x + 64 hex.
 *   CAPTURE_USDC_ADDRESS     — the settled-USDC token address on Base Sepolia (the swap input).
 *   CAPTURE_PAYOUT_TOKEN     — the merchant's payout token address (the swap output).
 * OPTIONAL env (documented defaults):
 *   CAPTURE_AMOUNT_USDC      — settled USDC to swap, ATOMIC base units. Default "1000000" (1 USDC, 6 dec).
 *   CAPTURE_MIN_AMOUNT_OUT   — slippage floor, ATOMIC in the payout token's decimals. Default "0".
 *
 * RUN (from `web/`):
 *   npm run capture:swap
 *   # or directly:
 *   tsx scripts/capture-payout-swap.mts
 *
 * On success it prints the swap tx hash and a `https://sepolia.basescan.org/tx/<hash>` link. A
 * skipped or failed swap prints the worker's reason + detail and exits non-zero — the rail never
 * throws across the settlement boundary, so this script surfaces the outcome instead of masking it.
 */
import { getAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

import { buildPayoutSwapDeps } from '../lib/payout-swap/deps-from-env.js'
import {
  runPayoutSwap,
  selectPayoutSwapClient,
  type SwapRequest,
} from '../lib/payout-swap/index.js'

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

/** Thrown when required capture env is missing — carries every missing NAME, never a value. */
class MissingCaptureEnvError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `capture-payout-swap: missing required env: ${missing.join(', ')}. ` +
        `Set each one (SELLER_PRIVATE_KEY is a funded Base-Sepolia burner — never hardcode a key).`,
    )
    this.name = 'MissingCaptureEnvError'
  }
}

/** Thrown when a supplied env value is present but malformed (address / key / amount). */
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

/** Build the Base-Sepolia swap request from validated env + the derived merchant address. */
function buildRequest(merchant: Address): SwapRequest {
  return {
    chainId: baseSepolia.id,
    usdc: requireAddress('CAPTURE_USDC_ADDRESS', env('CAPTURE_USDC_ADDRESS')),
    payoutToken: requireAddress('CAPTURE_PAYOUT_TOKEN', env('CAPTURE_PAYOUT_TOKEN')),
    merchant,
    amountUsdc: atomicAmount('CAPTURE_AMOUNT_USDC', env('CAPTURE_AMOUNT_USDC'), DEFAULT_AMOUNT_USDC),
    minAmountOut: atomicAmount('CAPTURE_MIN_AMOUNT_OUT', env('CAPTURE_MIN_AMOUNT_OUT'), DEFAULT_MIN_AMOUNT_OUT),
  }
}

/** Capture one real Base-Sepolia payout-swap: validate env, wire the rail, run it, print the tx. */
async function main(): Promise<void> {
  // Fail-fast: check the whole required set at once so the error lists every gap, not just the first.
  const missing = REQUIRED_ENV.filter((name) => env(name) === '')
  if (missing.length > 0) throw new MissingCaptureEnvError(missing)

  // Derive the merchant/swapper ADDRESS from the funded burner key; the key itself is never logged.
  const account = privateKeyToAccount(requirePrivateKey(env('SELLER_PRIVATE_KEY')))
  const req = buildRequest(account.address)

  // Exact production wiring: env → deps → the Base rail client. Base Sepolia is a capable chain,
  // so a missing config throws inside selectPayoutSwapClient; the null branch narrows the type.
  const deps = buildPayoutSwapDeps()
  const client = selectPayoutSwapClient(baseSepolia.id, deps)
  if (!client) {
    throw new InvalidCaptureEnvError(
      'Base Sepolia resolved no payout-swap rail — check UNISWAP_TRADING_API_URL',
    )
  }

  console.log(`Swapper (merchant): ${account.address}`)
  console.log(
    `Swapping ${req.amountUsdc} USDC base units -> ${req.payoutToken} on Base Sepolia ` +
      `(floor ${req.minAmountOut})…`,
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

  console.log(`Swapped via ${result.rail}. amountOut=${result.amountOut}`)
  console.log(`tx: ${result.txHash}`)
  console.log(`https://sepolia.basescan.org/tx/${result.txHash}`)
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
