/**
 * @file sellables.test.ts — the typed create-helpers prove their claims: the
 * module address comes from the broadcast map (honest unavailable error when
 * absent), human strings go on-chain only as keccak commitments, and every
 * helper returns the id parsed from its REAL creation event — a synthetic
 * receipt without the event is an error, never a guessed id.
 */
import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toHex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { getModuleAbi } from '../modules/registry'
import {
  ModuleUnavailableError,
  commitment,
  createInvoice,
  issueGiftCard,
  requireModule,
  setSubscriptionPlan,
} from './sellables'

const TX = '0x' + 'ab'.repeat(32)

/** A wallet/public client pair that returns a canned receipt — no network. */
function clients(logs: unknown[]): { wallet: WalletClient; publicClient: PublicClient } {
  const wallet = {
    account: { address: '0x' + '11'.repeat(20), type: 'json-rpc' },
    chain: undefined,
    writeContract: async () => TX,
  } as unknown as WalletClient
  const publicClient = {
    waitForTransactionReceipt: async () => ({ logs }),
  } as unknown as PublicClient
  return { wallet, publicClient }
}

/** Encode a real event log for a module's ABI (topics + data, viem-shaped). */
function eventLog(
  module: 'Access0x1Subscriptions' | 'Access0x1Invoices' | 'Access0x1GiftCards',
  eventName: string,
  indexed: Record<string, unknown>,
  dataTypes: { type: string }[],
  dataValues: unknown[],
): { address: string; topics: string[]; data: string } {
  const abi = getModuleAbi(module)
  const topics = encodeEventTopics({ abi, eventName, args: indexed } as never)
  return {
    address: '0x' + '22'.repeat(20),
    topics: topics as string[],
    data: encodeAbiParameters(dataTypes, dataValues),
  }
}

describe('requireModule — the broadcast map is the only address source', () => {
  it('resolves a live module on a mirrored chain (Base Sepolia)', () => {
    expect(requireModule(84532, 'Access0x1Invoices')).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('throws the honest unavailable error on a chain with no deployment', () => {
    expect(() => requireModule(1, 'Access0x1Invoices')).toThrow(ModuleUnavailableError)
    expect(() => requireModule(1, 'Access0x1Invoices')).toThrow('not on this chain yet')
  })
})

describe('commitment — human strings never go on-chain in the clear', () => {
  it('is the keccak-256 of the trimmed string', () => {
    expect(commitment('  WELCOME10  ')).toBe(keccak256(toHex('WELCOME10')))
  })
})

describe('setSubscriptionPlan — confirmed by the PlanSet event', () => {
  it('returns the planKey parsed from the receipt', async () => {
    const log = eventLog(
      'Access0x1Subscriptions',
      'PlanSet',
      { merchantId: 7n, planKey: 3 },
      [{ type: 'uint256' }, { type: 'uint32' }, { type: 'bool' }],
      [999_000_000n, 2_592_000, true],
    )
    const { wallet, publicClient } = clients([log])
    const res = await setSubscriptionPlan(wallet, publicClient, 84532, {
      merchantId: 7n,
      planKey: 3,
      priceUsd8: 999_000_000n,
      periodSecs: 2_592_000,
    })
    expect(res).toEqual({ txHash: TX, planKey: 3 })
  })

  it('errors honestly when the receipt carries no PlanSet event', async () => {
    const { wallet, publicClient } = clients([])
    await expect(
      setSubscriptionPlan(wallet, publicClient, 84532, {
        merchantId: 7n,
        planKey: 1,
        priceUsd8: 1n,
        periodSecs: 60,
      }),
    ).rejects.toThrow('PlanSet event not found')
  })
})

describe('createInvoice — confirmed by the InvoiceCreated event', () => {
  it('returns the on-chain invoice id from the receipt', async () => {
    const log = eventLog(
      'Access0x1Invoices',
      'InvoiceCreated',
      { id: 42n, merchantId: 7n, payer: '0x' + '00'.repeat(20) },
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'bytes32' }],
      ['0x' + '00'.repeat(20), 12_500_000_000n, 1_790_000_000n, commitment('Invoice #1')],
    )
    const { wallet, publicClient } = clients([log])
    const res = await createInvoice(wallet, publicClient, 84532, {
      merchantId: 7n,
      amountUsd8: 12_500_000_000n,
      dueBy: 1_790_000_000n,
      memo: 'Invoice #1',
    })
    expect(res).toEqual({ txHash: TX, invoiceId: 42n })
  })
})

describe('issueGiftCard — confirmed by the CardIssued event', () => {
  it('returns the on-chain card id from the receipt', async () => {
    const recipient = ('0x' + '33'.repeat(20)) as `0x${string}`
    const log = eventLog(
      'Access0x1GiftCards',
      'CardIssued',
      { merchantId: 7n, cardId: 12345n, recipient },
      [{ type: 'uint256' }],
      [50_000_000_00n],
    )
    const { wallet, publicClient } = clients([log])
    const res = await issueGiftCard(wallet, publicClient, 84532, {
      merchantId: 7n,
      code: 'WELCOME10',
      recipient,
      faceUsd8: 50_000_000_00n,
    })
    expect(res).toEqual({ txHash: TX, cardId: 12345n })
  })
})
