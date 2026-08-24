/**
 * fakeSdk.test.ts — the in-repo fake shielded set's own semantics.
 *
 * The fake is only worth having when exercising the seam against it is a REAL
 * test rather than a tautology. That means the fake has to be able to say no:
 * refuse an over-withdrawal, refuse to spend a deposit that has not settled,
 * refuse a duplicate registration. This file pins those refusals, because a fake
 * that always says yes would turn the assembled-seam test into theatre.
 *
 * It also pins the honesty markers: every hash is deterministic and visibly
 * synthetic, so a transcript can never be mistaken for on-chain evidence.
 */
import { beforeEach, describe, expect, it } from 'vitest'

const {
  createFakeUnlinkSdk,
  fakeShieldedBalance,
  fakeUnlinkTranscript,
  failNextFakeUnlinkCall,
  __resetFakeUnlink,
  FAKE_TX_MARKER,
} = await import('../lib/unlink/fakeSdk.js')

const TOKEN = '0x2222222222222222222222222222222222222222' as const
const DEST = '0x1111111111111111111111111111111111111111' as const
const USER = 'user-1'

beforeEach(() => {
  __resetFakeUnlink()
})

const client = () => createFakeUnlinkSdk().createUnlinkClient({
  environment: 'arc-testnet',
  account: { address: '0x3333333333333333333333333333333333333333' },
  userId: USER,
})

describe('the fake shielded set — bookkeeping is real', () => {
  it('credits the balance only after the deposit SETTLES', async () => {
    const c = client()
    const { txHash } = await c.depositWithApproval({ token: TOKEN, amount: 1_000_000n })

    // Deposited but unsettled: not yet spendable.
    expect(fakeShieldedBalance(USER)).toBe(0n)
    await expect(c.withdraw({ amount: 1n, destination: DEST })).rejects.toThrow(/insufficient/)

    await c.waitForTx(txHash)
    expect(fakeShieldedBalance(USER)).toBe(1_000_000n)
  })

  it('refuses to withdraw more than was shielded', async () => {
    const c = client()
    const { txHash } = await c.depositWithApproval({ token: TOKEN, amount: 1_000_000n })
    await c.waitForTx(txHash)
    await expect(c.withdraw({ amount: 1_000_001n, destination: DEST })).rejects.toThrow(
      /insufficient shielded balance/,
    )
    // A refused withdrawal takes nothing.
    expect(fakeShieldedBalance(USER)).toBe(1_000_000n)
  })

  it('debits exactly what it withdraws, leaving the asymmetric residue', async () => {
    const c = client()
    const { txHash } = await c.depositWithApproval({ token: TOKEN, amount: 10_000_000n })
    await c.waitForTx(txHash)
    await c.withdraw({ amount: 4_000_000n, destination: DEST })
    expect(fakeShieldedBalance(USER)).toBe(6_000_000n)
  })

  it('shares one balance across separate clients for the same user', async () => {
    const sdk = createFakeUnlinkSdk()
    const mk = () =>
      sdk.createUnlinkClient({
        environment: 'arc-testnet',
        account: { address: '0x3333333333333333333333333333333333333333' },
        userId: USER,
      })
    const a = mk()
    const { txHash } = await a.depositWithApproval({ token: TOKEN, amount: 5_000_000n })
    await a.waitForTx(txHash)
    // A second client instance sees the same shielded account, as real ones would.
    await expect(mk().withdraw({ amount: 5_000_000n, destination: DEST })).resolves.toBeTruthy()
    expect(fakeShieldedBalance(USER)).toBe(0n)
  })
})

describe('the fake shielded set — registration', () => {
  it('rejects a duplicate registration with the message ensureRegistered swallows', async () => {
    const admin = createFakeUnlinkSdk().createUnlinkAdmin({
      environment: 'arc-testnet',
      apiKey: 'not-a-key',
    })
    await admin.users.register({ userId: USER })
    await expect(admin.users.register({ userId: USER })).rejects.toThrow(/already regist/i)
  })
})

describe('the fake shielded set — injected failures', () => {
  it('fires once and disarms, so a retry succeeds', async () => {
    const c = client()
    failNextFakeUnlinkCall('deposit')
    await expect(c.depositWithApproval({ token: TOKEN, amount: 1n })).rejects.toThrow(/failed/)
    await expect(c.depositWithApproval({ token: TOKEN, amount: 1n })).resolves.toBeTruthy()
  })

  it('only fires for the call it names', async () => {
    const c = client()
    failNextFakeUnlinkCall('withdraw')
    await expect(c.depositWithApproval({ token: TOKEN, amount: 1n })).resolves.toBeTruthy()
  })
})

describe('the fake shielded set — honesty markers', () => {
  it('marks every hash as synthetic and never mints two the same', async () => {
    const c = client()
    const a = await c.depositWithApproval({ token: TOKEN, amount: 1_000_000n })
    await c.waitForTx(a.txHash)
    const b = await c.withdraw({ amount: 1n, destination: DEST })

    for (const { txHash } of [a, b]) {
      expect(txHash.startsWith(`0x${FAKE_TX_MARKER}`)).toBe(true)
      expect(txHash).toHaveLength(66)
    }
    expect(a.txHash).not.toBe(b.txHash)
  })

  it('is deterministic — an identical sequence reproduces identical hashes', async () => {
    const run = async (): Promise<string> => {
      __resetFakeUnlink()
      const c = client()
      const { txHash } = await c.depositWithApproval({ token: TOKEN, amount: 7_000_000n })
      return txHash
    }
    expect(await run()).toBe(await run())
  })

  it('never echoes the private key it derives an address from', async () => {
    const key = `0x${'ab'.repeat(32)}` as const
    const acct = await createFakeUnlinkSdk().account.fromKeys({ privateKey: key })
    expect(acct.address).not.toContain('abab')
    expect(acct.address).toHaveLength(42)
  })

  it('records the full transcript in call order', async () => {
    const sdk = createFakeUnlinkSdk()
    await sdk.createUnlinkAdmin({ environment: 'arc-testnet', apiKey: 'x' }).users.register({
      userId: USER,
    })
    const c = client()
    const { txHash } = await c.depositWithApproval({ token: TOKEN, amount: 2_000_000n })
    await c.waitForTx(txHash)
    await c.withdraw({ amount: 1_000_000n, destination: DEST })
    expect(fakeUnlinkTranscript().map((e) => e.kind)).toEqual([
      'register',
      'deposit',
      'waitForTx',
      'withdraw',
    ])
  })
})
