/**
 * fakeSdk.ts — an in-repo, deterministic FAKE shielded set that satisfies the
 * `@unlink-xyz/sdk` surface this app consumes.
 *
 * WHY IT EXISTS. Every module in `lib/unlink/*` is written and tested, and none
 * of it has ever run end-to-end: the real SDK is absent from `node_modules`, so
 * `loadUnlinkSdk()` throws and each path falls back to the public rail. Unit
 * tests mock the SDK per file, which proves each unit in isolation but proves
 * nothing about the seam ASSEMBLED — the auth gate, the owner binding, the
 * validation order, registration-before-shield, the asymmetry keystone, and the
 * two law-#5 error surfaces all meeting in one request. This module is the
 * substrate that lets the whole path execute with no proprietary dependency, no
 * new npm package, and no change to any production code path.
 *
 * WHAT IT IS NOT. It is not the SDK, it is not a shielded set, and it settles
 * NOTHING. No chain is touched, no key signs, no value moves. Every tx hash it
 * returns is synthetic and marked as such (see {@link FAKE_TX_MARKER}) precisely
 * so a hash from here can never be mistaken for, or pasted as, an on-chain
 * artifact. Nothing this module produces may be cited as evidence that the
 * private rail is live — the rail stays "built, env-gated, dependency-absent"
 * until the real package settles a real testnet transaction.
 *
 * WHAT IT IS. A faithful implementation of the SEMANTICS the seam depends on, so
 * that exercising the seam against it is a real test rather than a tautology:
 *
 *  - `users.register` is stateful — a second register for the same userId throws
 *    "already registered", which is the exact case `ensureRegistered` swallows.
 *  - The shielded balance is real bookkeeping: `depositWithApproval` credits it,
 *    `withdraw` debits it and REFUSES when the balance is short.
 *  - A deposit is not spendable until `waitForTx` has settled it, so the
 *    documented call order (deposit → waitForTx → withdraw) is ENFORCED rather
 *    than merely asserted by a spy. Code that withdrew too early would fail here.
 *  - Hashes are deterministic in their inputs, so a recorded transcript is
 *    reproducible rather than a fresh random string each run.
 *
 * Selected only by `fakeSdkEnabled()` (`UNLINK_FAKE_SDK=true`, refused in
 * production). See `fakeSdkFlag.ts`.
 */

import { createHash } from 'node:crypto'
import type {
  CreateUnlinkAdminParams,
  CreateUnlinkClientParams,
  TxReceipt,
  UnlinkAccount,
  UnlinkAdmin,
  UnlinkClient,
} from '@unlink-xyz/sdk'
import type { UnlinkSdk } from './loadSdk.js'

/**
 * The leading nibbles of every hash this module mints. A real Arc tx hash has no
 * reason to start with these, and a transcript full of `0xfa4e…` hashes is
 * self-evidently synthetic at a glance — which is the point.
 */
export const FAKE_TX_MARKER = 'fa4e' as const

/** One recorded call against the fake. The transcript a test or demo reads back. */
export interface FakeUnlinkEvent {
  kind: 'register' | 'deposit' | 'waitForTx' | 'withdraw' | 'transfer'
  userId?: string
  amount?: bigint
  token?: string
  destination?: string
  txHash?: string
}

/** The failure a test asks the fake to inject on the next matching call. */
export type FakeUnlinkFailure = 'deposit' | 'withdraw' | 'transfer' | 'register' | null

interface FakeLedger {
  /** userIds that have been registered. */
  registered: Set<string>
  /** Settled shielded balance per userId, in USDC base units. */
  balance: Map<string, bigint>
  /** Deposits minted but not yet settled by `waitForTx`, by tx hash. */
  pending: Map<string, { userId: string; amount: bigint }>
  /** Every call, in order. */
  events: FakeUnlinkEvent[]
  /** Monotonic counter so two identical calls still get distinct hashes. */
  seq: number
  /** The next injected failure, consumed when it fires. */
  failNext: FakeUnlinkFailure
}

function emptyLedger(): FakeLedger {
  return {
    registered: new Set<string>(),
    balance: new Map<string, bigint>(),
    pending: new Map<string, { userId: string; amount: bigint }>(),
    events: [],
    seq: 0,
    failNext: null,
  }
}

let ledger: FakeLedger = emptyLedger()

/**
 * The transcript of everything the fake has been asked to do, in order. Read it
 * to assert the seam's call ORDER (register before shield, wait before withdraw)
 * rather than only its return value.
 */
export function fakeUnlinkTranscript(): readonly FakeUnlinkEvent[] {
  return ledger.events
}

/** The settled shielded balance the fake is holding for a userId, in base units. */
export function fakeShieldedBalance(userId: string): bigint {
  return ledger.balance.get(userId) ?? 0n
}

/**
 * Arm a single injected failure. Consumed by the next matching call, so a test
 * drives the `shield_failed` / `withdraw_failed` branches deterministically
 * without stubbing anything — the real error types still come from the real
 * `shieldAndWithdraw`, which is what makes those assertions meaningful.
 *
 * @param failure - which call should throw next, or null to disarm.
 */
export function failNextFakeUnlinkCall(failure: FakeUnlinkFailure): void {
  ledger.failNext = failure
}

/** Wipe all fake state — registrations, balances, transcript, armed failures. */
export function __resetFakeUnlink(): void {
  ledger = emptyLedger()
}

/** A deterministic, obviously-synthetic 32-byte hash for one recorded action. */
function fakeTxHash(kind: string, parts: readonly string[]): `0x${string}` {
  ledger.seq += 1
  const digest = createHash('sha256')
    .update([kind, String(ledger.seq), ...parts].join('|'))
    .digest('hex')
  return `0x${FAKE_TX_MARKER}${digest.slice(0, 60)}` as `0x${string}`
}

/** Consume an armed failure when it matches this call. */
function shouldFail(kind: NonNullable<FakeUnlinkFailure>): boolean {
  if (ledger.failNext !== kind) return false
  ledger.failNext = null
  return true
}

/** A deterministic pseudo-address derived from a secret, never the secret itself. */
function derivedAddress(seed: string): `0x${string}` {
  const digest = createHash('sha256').update(`unlink-fake-account|${seed}`).digest('hex')
  return `0x${digest.slice(0, 40)}` as `0x${string}`
}

/**
 * Build the fake SDK surface. Every client created for the same `userId` shares
 * one ledger, exactly as separate real client instances would share one shielded
 * account — so a deposit made through one client is spendable through another.
 *
 * @returns a module-shaped object satisfying the four bindings the app consumes.
 */
export function createFakeUnlinkSdk(): UnlinkSdk {
  return {
    account: {
      /**
       * A seed-backed account. The address is derived from the signature so it is
       * stable per signature — mirroring the real SDK's determinism, which is the
       * property `deriveMerchantAccount` depends on.
       */
      async fromEthereumSignature({ signature, appId, chainId }): Promise<UnlinkAccount> {
        return { address: derivedAddress(`${signature}|${appId}|${chainId}`) }
      },
      /**
       * A key-backed account (no `execute` capability — zero custody). The private
       * key is hashed into the address and NEVER stored or echoed anywhere.
       */
      async fromKeys({ privateKey }): Promise<UnlinkAccount> {
        return { address: derivedAddress(privateKey) }
      },
    },

    /**
     * The deterministic seed message. Binds `appId` and `chainId` exactly as the
     * vendor docs describe, so a chain mismatch produces a DIFFERENT message —
     * and therefore a different account — instead of silently sharing one.
     */
    buildDeriveSeedMessage({ appId, chainId }): string {
      return `Unlink account derivation\napp: ${appId}\nchain: ${chainId}`
    },

    createUnlinkAdmin(_params: CreateUnlinkAdminParams): UnlinkAdmin {
      // The api key is accepted and immediately discarded — the fake has nothing
      // to authenticate against, and holding it would serve no purpose.
      return {
        users: {
          async register({ userId }: { userId: string }): Promise<void> {
            if (shouldFail('register')) {
              throw new Error('fake unlink: register failed')
            }
            if (ledger.registered.has(userId)) {
              // The exact shape `ensureRegistered` recognises and swallows.
              throw new Error(`user ${userId} is already registered`)
            }
            ledger.registered.add(userId)
            ledger.events.push({ kind: 'register', userId })
          },
        },
      }
    },

    createUnlinkClient({ userId }: CreateUnlinkClientParams): UnlinkClient {
      return {
        async depositWithApproval({ token, amount }): Promise<TxReceipt> {
          if (shouldFail('deposit')) {
            throw new Error('fake unlink: depositWithApproval failed')
          }
          if (amount <= 0n) {
            throw new Error('fake unlink: deposit amount must be positive')
          }
          const txHash = fakeTxHash('deposit', [userId, token, amount.toString()])
          // Credited to PENDING, not to the balance: it becomes spendable only
          // after waitForTx, so an implementation that withdrew early would fail.
          ledger.pending.set(txHash, { userId, amount })
          ledger.events.push({ kind: 'deposit', userId, token, amount, txHash })
          return { txHash }
        },

        async waitForTx(txHash): Promise<TxReceipt> {
          const pending = ledger.pending.get(txHash)
          if (pending) {
            ledger.pending.delete(txHash)
            ledger.balance.set(pending.userId, fakeShieldedBalance(pending.userId) + pending.amount)
          }
          ledger.events.push({ kind: 'waitForTx', userId, txHash })
          return { txHash }
        },

        async withdraw({ amount, destination }): Promise<TxReceipt> {
          if (shouldFail('withdraw')) {
            throw new Error('fake unlink: withdraw failed')
          }
          const available = fakeShieldedBalance(userId)
          if (amount <= 0n) {
            throw new Error('fake unlink: withdraw amount must be positive')
          }
          if (amount > available) {
            // Real bookkeeping: withdrawing more than was shielded and settled is
            // refused, so the asymmetry keystone is enforced end-to-end and not
            // merely asserted upstream.
            throw new Error(
              `fake unlink: insufficient shielded balance (have ${available}, want ${amount})`,
            )
          }
          ledger.balance.set(userId, available - amount)
          const txHash = fakeTxHash('withdraw', [userId, destination, amount.toString()])
          ledger.events.push({ kind: 'withdraw', userId, amount, destination, txHash })
          return { txHash }
        },

        async transfer({ amount, to }): Promise<TxReceipt> {
          if (shouldFail('transfer')) {
            throw new Error('fake unlink: transfer failed')
          }
          const available = fakeShieldedBalance(userId)
          if (amount > available) {
            throw new Error('fake unlink: insufficient shielded balance for transfer')
          }
          const txHash = fakeTxHash('transfer', [userId, to, amount.toString()])
          ledger.events.push({ kind: 'transfer', userId, amount, destination: to, txHash })
          return { txHash }
        },
      }
    },
  }
}
