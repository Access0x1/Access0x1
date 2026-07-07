/**
 * @file contracts-abi.test.ts — pins the Router ABI ⇄ UI contract + the pure
 * PaymentReceived decoder.
 *
 * These are pure invariants (no RPC, no wallet, no money movement):
 *
 *   1. Every revert name the checkout UI matches BY STRING
 *      (`CheckoutCard.humanizeRevert` + `CheckoutView`) exists as an `error`
 *      fragment in `ROUTER_ABI`. If the contract renames an error and the ABI
 *      fragment drifts, the UI silently loses its human-friendly message and
 *      falls back to "Payment failed" — this test is the tripwire.
 *   2. The read/write function fragments the frontend calls exist with the
 *      right stateMutability (a `payable` that becomes `nonpayable`, or a
 *      renamed getter, breaks checkout at runtime, not at build).
 *   3. NATIVE_TOKEN is the address(0) sentinel the native-pay path relies on.
 *   4. parsePaymentReceived round-trips a real encoded `PaymentReceived` log
 *      into the typed struct, and throws (never silently returns garbage) when
 *      no such event is present.
 */
import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  encodeEventTopics,
  pad,
  toHex,
  type AbiEvent,
} from 'viem'
import {
  ROUTER_ABI,
  NATIVE_TOKEN,
  parsePaymentReceived,
  type PaymentReceivedEvent,
} from '../lib/contracts.js'

// --- ABI introspection helpers -------------------------------------------
// Widen the `as const` literal-union names to plain `string` so lookups with an
// arbitrary name compile (the whole point is to catch a name that ISN'T there).
type RouterFn = Extract<(typeof ROUTER_ABI)[number], { type: 'function' }>
type RouterEv = Extract<(typeof ROUTER_ABI)[number], { type: 'event' }>

const errorNames: Set<string> = new Set(
  ROUTER_ABI.filter((f) => f.type === 'error').map((f) => f.name),
)
const functionByName: Map<string, RouterFn> = new Map(
  ROUTER_ABI.filter((f): f is RouterFn => f.type === 'function').map((f) => [f.name, f]),
)
const eventByName: Map<string, RouterEv> = new Map(
  ROUTER_ABI.filter((f): f is RouterEv => f.type === 'event').map((f) => [f.name, f]),
)

describe('ROUTER_ABI ⇄ UI revert-name contract', () => {
  // The exact strings CheckoutCard.humanizeRevert + CheckoutView match against.
  // If any of these is missing from the ABI, viem cannot decode the custom
  // error, `err.message` never contains the name, and the friendly copy is lost.
  const UI_MATCHED_ERRORS = [
    'Access0x1__MerchantInactive',
    'Access0x1__MerchantNotFound',
    'Access0x1__TokenNotAllowed',
    'Access0x1__Underpaid',
    'Access0x1__InvalidPrice',
    'OracleLib__StalePrice',
  ] as const

  it.each(UI_MATCHED_ERRORS)(
    'declares the "%s" error the checkout UI humanizes by name',
    (name) => {
      expect(errorNames.has(name)).toBe(true)
    },
  )

  it('also declares the registry/guard errors documented in the file header', () => {
    for (const name of [
      'Access0x1__ZeroAddress',
      'Access0x1__FeeTooHigh',
      'Access0x1__NotMerchantOwner',
      'Access0x1__FeeOnTransferToken',
      'Access0x1__ZeroAmount',
    ]) {
      expect(errorNames.has(name)).toBe(true)
    }
  })
})

describe('ROUTER_ABI — the fragments the frontend calls', () => {
  it('exposes the read functions as `view`', () => {
    for (const name of ['merchants', 'quote', 'platformFeeBps', 'tokenAllowed']) {
      expect(functionByName.get(name)?.stateMutability).toBe('view')
    }
  })

  it('payToken is nonpayable and payNative is payable (native pay sends value)', () => {
    expect(functionByName.get('payToken')?.stateMutability).toBe('nonpayable')
    expect(functionByName.get('payNative')?.stateMutability).toBe('payable')
  })

  it('registerMerchant returns the new merchant id', () => {
    const frag = functionByName.get('registerMerchant')
    expect(frag?.stateMutability).toBe('nonpayable')
    expect(frag?.outputs.map((o) => o.type)).toEqual(['uint256'])
  })

  it('merchants() decodes to the 6-field record getMerchant destructures', () => {
    // getMerchant relies on this exact positional tuple order.
    expect(functionByName.get('merchants')?.outputs.map((o) => o.type)).toEqual([
      'address', // payout
      'address', // owner
      'address', // feeRecipient
      'uint16', // feeBps
      'bool', // active
      'bytes32', // nameHash
    ])
  })

  it('declares both settlement events', () => {
    expect(eventByName.has('MerchantRegistered')).toBe(true)
    expect(eventByName.has('PaymentReceived')).toBe(true)
  })
})

describe('NATIVE_TOKEN — the address(0) native-coin sentinel', () => {
  it('is the zero address (getQuote(NATIVE_TOKEN) means "price the native coin")', () => {
    expect(NATIVE_TOKEN).toBe('0x0000000000000000000000000000000000000000')
  })
})

describe('parsePaymentReceived — the pure receipt decoder', () => {
  const PAYMENT_EVENT = eventByName.get('PaymentReceived') as AbiEvent

  // Build a genuine on-chain-shaped PaymentReceived log so the decoder is
  // exercised end-to-end, exactly as viem hands it off from a real receipt.
  const merchantId = 7n
  const buyer = '0x1111111111111111111111111111111111111111' as const
  const token = '0x2222222222222222222222222222222222222222' as const
  const gross = 1_000_000n
  const fee = 25_000n
  const net = 975_000n
  const usdAmount8 = 100_000_000n // $1.00 at 8 decimals
  const orderId = pad('0xabcd', { size: 32 })
  const srcChainSelector = 16_015_286_601_757_825_753n // a real CCIP selector

  const topics = encodeEventTopics({
    abi: ROUTER_ABI,
    eventName: 'PaymentReceived',
    args: { merchantId, buyer, token },
  })
  // Non-indexed params, in ABI order.
  const data = encodeAbiParameters(
    PAYMENT_EVENT.inputs.filter((i) => !i.indexed),
    [gross, fee, net, usdAmount8, orderId, srcChainSelector],
  )

  const log = { data, topics: topics as [`0x${string}`, ...`0x${string}`[]] }

  it('round-trips a real encoded log into the typed struct', () => {
    const decoded: PaymentReceivedEvent = parsePaymentReceived([log])
    expect(decoded.merchantId).toBe(merchantId)
    expect(decoded.buyer.toLowerCase()).toBe(buyer)
    expect(decoded.token.toLowerCase()).toBe(token)
    expect(decoded.grossAmount).toBe(gross)
    expect(decoded.feeAmount).toBe(fee)
    expect(decoded.netAmount).toBe(net)
    expect(decoded.usdAmount8).toBe(usdAmount8)
    expect(decoded.orderId).toBe(orderId)
    expect(decoded.srcChainSelector).toBe(srcChainSelector)
  })

  it('gross = fee + net for the fixture (the split the UI renders honestly)', () => {
    const decoded = parsePaymentReceived([log])
    expect(decoded.feeAmount + decoded.netAmount).toBe(decoded.grossAmount)
  })

  it('returns the FIRST PaymentReceived when a receipt carries several logs', () => {
    // An unrelated topic (e.g. an ERC-20 Transfer) must be skipped, not decoded.
    const unrelated = {
      data: '0x' as `0x${string}`,
      topics: [toHex(1, { size: 32 })] as [`0x${string}`, ...`0x${string}`[]],
    }
    const decoded = parsePaymentReceived([unrelated, log])
    expect(decoded.merchantId).toBe(merchantId)
  })

  it('throws (never silently returns) when no PaymentReceived log is present', () => {
    const unrelated = {
      data: '0x' as `0x${string}`,
      topics: [toHex(9, { size: 32 })] as [`0x${string}`, ...`0x${string}`[]],
    }
    expect(() => parsePaymentReceived([unrelated])).toThrow(/PaymentReceived/)
    expect(() => parsePaymentReceived([])).toThrow(/PaymentReceived/)
  })
})
