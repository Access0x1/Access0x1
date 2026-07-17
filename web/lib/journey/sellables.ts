/**
 * sellables.ts — the typed "create things a business sells" helpers for the
 * journey wizard, in the contracts.ts discipline: each write resolves its
 * module's PROXY address from the broadcast map (never a literal), submits
 * through the one runtime-ABI seam (lib/modules/call.ts), waits for the
 * receipt, and parses its CREATION EVENT so the UI reports the real on-chain
 * id — an id that isn't in a receipt isn't claimed (law: verify or it didn't
 * happen).
 *
 * Lifecycle order (mirrors the contract surface):
 *   registerMerchant (lib/contracts.ts) → setSubscriptionPlan → createInvoice
 *   → issueGiftCard. Merchant-scoped writes revert on-chain unless the wallet
 *   IS `router.merchants(id).owner` — these helpers add no client-side gate on
 *   top (the chain is the authority; the UI surfaces the revert honestly).
 *
 * Human strings (invoice memos, gift-card codes) never leave the browser:
 * like the router's nameHash, only their keccak-256 commitment goes on-chain.
 */
import {
  keccak256,
  parseEventLogs,
  toHex,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { getModuleAbi, moduleAddressFor } from '@/lib/modules/registry'
import { writeModuleWithReceipt } from '@/lib/modules/call'
import type { ModuleName } from '@/lib/generated/module-abis'

/** The zero address: "anyone may pay" for invoices, native token selector. */
export const ANYONE: Address = '0x0000000000000000000000000000000000000000'

/** Thrown when a module has no broadcast address on the wallet's chain. */
export class ModuleUnavailableError extends Error {
  readonly module: ModuleName
  readonly chainId: number
  constructor(module: ModuleName, chainId: number) {
    super(`${module} is not on this chain yet — switch network or try another step.`)
    this.name = 'ModuleUnavailableError'
    this.module = module
    this.chainId = chainId
  }
}

/** Resolve a module's live proxy address or throw the honest unavailable error. */
export function requireModule(chainId: number, module: ModuleName): Address {
  const address = moduleAddressFor(chainId, module)
  if (!address) throw new ModuleUnavailableError(module, chainId)
  return address
}

/** keccak-256 commitment of a human string (memoHash / gift-card code). */
export function commitment(text: string): `0x${string}` {
  return keccak256(toHex(text.trim()))
}

/**
 * Create (or reprice) a subscription plan: `setPlan(merchantId, planKey,
 * priceUsd8, periodSecs, active=true)` on Access0x1Subscriptions. Confirms via
 * the `PlanSet` event.
 */
export async function setSubscriptionPlan(
  walletClient: WalletClient,
  publicClient: PublicClient,
  chainId: number,
  args: { merchantId: bigint; planKey: number; priceUsd8: bigint; periodSecs: number },
): Promise<{ txHash: Hash; planKey: number }> {
  const abi = getModuleAbi('Access0x1Subscriptions')
  const address = requireModule(chainId, 'Access0x1Subscriptions')
  const { hash, receipt } = await writeModuleWithReceipt(
    walletClient,
    publicClient,
    address,
    abi,
    'setPlan',
    [args.merchantId, args.planKey, args.priceUsd8, args.periodSecs, true],
  )
  const events = parseEventLogs({ abi, eventName: 'PlanSet', logs: receipt.logs })
  const ev = events[0]?.args as { planKey?: number } | undefined
  if (ev?.planKey === undefined) {
    throw new Error('setPlan: PlanSet event not found in receipt')
  }
  return { txHash: hash, planKey: ev.planKey }
}

/**
 * Create an invoice: `createInvoice(merchantId, payer, token, amountUsd8,
 * dueBy, memoHash)` on Access0x1Invoices. `payer = 0x0` means anyone may pay;
 * `token = 0x0` means the chain's native coin. The memo goes on-chain only as
 * its keccak commitment. Confirms via `InvoiceCreated` and returns the id.
 */
export async function createInvoice(
  walletClient: WalletClient,
  publicClient: PublicClient,
  chainId: number,
  args: {
    merchantId: bigint
    payer?: Address
    token?: Address
    amountUsd8: bigint
    dueBy: bigint
    memo: string
  },
): Promise<{ txHash: Hash; invoiceId: bigint }> {
  const abi = getModuleAbi('Access0x1Invoices')
  const address = requireModule(chainId, 'Access0x1Invoices')
  const { hash, receipt } = await writeModuleWithReceipt(
    walletClient,
    publicClient,
    address,
    abi,
    'createInvoice',
    [
      args.merchantId,
      args.payer ?? ANYONE,
      args.token ?? ANYONE,
      args.amountUsd8,
      args.dueBy,
      commitment(args.memo),
    ],
  )
  const events = parseEventLogs({ abi, eventName: 'InvoiceCreated', logs: receipt.logs })
  const ev = events[0]?.args as { id?: bigint } | undefined
  if (ev?.id === undefined) {
    throw new Error('createInvoice: InvoiceCreated event not found in receipt')
  }
  return { txHash: hash, invoiceId: ev.id }
}

/**
 * Issue a gift card: `issueCard(merchantId, code, recipient, faceUsd8)` on
 * Access0x1GiftCards. The human code string is committed with keccak-256 —
 * redeeming later means hashing the SAME string, so the code itself never
 * appears on-chain. Confirms via `CardIssued` and returns the card id.
 */
export async function issueGiftCard(
  walletClient: WalletClient,
  publicClient: PublicClient,
  chainId: number,
  args: { merchantId: bigint; code: string; recipient: Address; faceUsd8: bigint },
): Promise<{ txHash: Hash; cardId: bigint }> {
  const abi = getModuleAbi('Access0x1GiftCards')
  const address = requireModule(chainId, 'Access0x1GiftCards')
  const { hash, receipt } = await writeModuleWithReceipt(
    walletClient,
    publicClient,
    address,
    abi,
    'issueCard',
    [args.merchantId, commitment(args.code), args.recipient, args.faceUsd8],
  )
  const events = parseEventLogs({ abi, eventName: 'CardIssued', logs: receipt.logs })
  const ev = events[0]?.args as { cardId?: bigint } | undefined
  if (ev?.cardId === undefined) {
    throw new Error('issueCard: CardIssued event not found in receipt')
  }
  return { txHash: hash, cardId: ev.cardId }
}
