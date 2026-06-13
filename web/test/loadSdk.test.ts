/**
 * @file loadSdk.test.ts — the optional/dynamic Unlink SDK loader (Part A fix #3).
 *
 * The proprietary `@unlink-xyz/sdk` is installed only at the booth. The guarded
 * loader must (a) return the module when present (here, the vitest mock) and
 * (b) throw a clean, recoverable UnlinkSdkUnavailableError when absent — so
 * `next build` succeeds without the package and the private payout leg fails
 * soft instead of crashing module load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('loadUnlinkSdk — present (mocked) module', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('@unlink-xyz/sdk')
  })

  it('returns the SDK surface when the package resolves', async () => {
    vi.doMock('@unlink-xyz/sdk', () => ({
      account: { fromEthereumSignature: vi.fn(), fromKeys: vi.fn() },
      buildDeriveSeedMessage: vi.fn(),
      createUnlinkAdmin: vi.fn(),
      createUnlinkClient: vi.fn(),
    }))
    const { loadUnlinkSdk } = await import('../lib/unlink/loadSdk.js')
    const sdk = await loadUnlinkSdk()
    expect(typeof sdk.createUnlinkClient).toBe('function')
    expect(typeof sdk.createUnlinkAdmin).toBe('function')
    expect(typeof sdk.buildDeriveSeedMessage).toBe('function')
    expect(sdk.account).toBeDefined()
  })
})

describe('loadUnlinkSdk — absent package (pre-booth, fail-soft)', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('@unlink-xyz/sdk')
  })

  it('throws a recoverable UnlinkSdkUnavailableError, never leaks a stack', async () => {
    // Simulate the package not being installed: the dynamic import rejects.
    vi.doMock('@unlink-xyz/sdk', () => {
      throw new Error("Cannot find module '@unlink-xyz/sdk'")
    })
    const { loadUnlinkSdk, UnlinkSdkUnavailableError } = await import(
      '../lib/unlink/loadSdk.js'
    )
    let caught: unknown
    try {
      await loadUnlinkSdk()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(UnlinkSdkUnavailableError)
    expect((caught as InstanceType<typeof UnlinkSdkUnavailableError>).recoverable).toBe(true)
    expect((caught as InstanceType<typeof UnlinkSdkUnavailableError>).code).toBe(
      'unlink_sdk_unavailable',
    )
  })
})
