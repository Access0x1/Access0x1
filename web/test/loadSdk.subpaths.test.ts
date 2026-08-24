/**
 * loadSdk.subpaths.test.ts — resolution order for the Unlink SDK loader.
 *
 * THE BUG THIS PINS. The loader imported only the bare `@unlink-xyz/sdk`
 * specifier. The published package's current canary exports map has no root `.`
 * entry — only subpaths — so that import fails to resolve even with the package
 * INSTALLED, the catch converts it to `UnlinkSdkUnavailableError`, and every
 * caller falls back to the public rail. Installing the SDK would have changed
 * nothing, silently. The loader now falls through to the documented subpaths.
 *
 * Root-first is deliberate and load-bearing: when the root resolves, its
 * namespace is returned whole, exactly as before. That keeps the local type shim
 * and the older `latest` dist-tag working, and keeps every per-unit test that
 * mocks the root with a partial surface working unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const SPECIFIERS = [
  '@unlink-xyz/sdk',
  '@unlink-xyz/sdk/crypto',
  '@unlink-xyz/sdk/admin',
  '@unlink-xyz/sdk/client',
] as const

/** Make the root specifier fail to resolve — the real canary's behaviour. */
function rootMissing(): void {
  vi.doMock('@unlink-xyz/sdk', () => {
    throw new Error("Cannot find module '@unlink-xyz/sdk'")
  })
}

afterEach(() => {
  vi.resetModules()
  for (const s of SPECIFIERS) vi.doUnmock(s)
  delete process.env.UNLINK_FAKE_SDK
})

describe('loadUnlinkSdk — root specifier', () => {
  it('returns the root namespace whole when it resolves, without touching a subpath', async () => {
    const clientFromRoot = vi.fn()
    vi.doMock('@unlink-xyz/sdk', () => ({
      account: { fromEthereumSignature: vi.fn(), fromKeys: vi.fn() },
      buildDeriveSeedMessage: vi.fn(),
      createUnlinkAdmin: vi.fn(),
      createUnlinkClient: clientFromRoot,
    }))
    const subpathProbe = vi.fn()
    vi.doMock('@unlink-xyz/sdk/client', () => {
      subpathProbe()
      return { createUnlinkClient: vi.fn() }
    })

    const { loadUnlinkSdk } = await import('../lib/unlink/loadSdk.js')
    const sdk = await loadUnlinkSdk()
    expect(sdk.createUnlinkClient).toBe(clientFromRoot)
    expect(subpathProbe).not.toHaveBeenCalled()
  })
})

describe('loadUnlinkSdk — subpath composition when the root is absent', () => {
  it('assembles all four bindings from the documented subpaths', async () => {
    rootMissing()
    const acct = { fromEthereumSignature: vi.fn(), fromKeys: vi.fn() }
    const seed = vi.fn()
    const admin = vi.fn()
    const client = vi.fn()
    vi.doMock('@unlink-xyz/sdk/crypto', () => ({
      account: acct,
      buildDeriveSeedMessage: seed,
    }))
    vi.doMock('@unlink-xyz/sdk/admin', () => ({ createUnlinkAdmin: admin }))
    vi.doMock('@unlink-xyz/sdk/client', () => ({ createUnlinkClient: client }))

    const { loadUnlinkSdk } = await import('../lib/unlink/loadSdk.js')
    const sdk = await loadUnlinkSdk()
    expect(sdk.account).toBe(acct)
    expect(sdk.buildDeriveSeedMessage).toBe(seed)
    expect(sdk.createUnlinkAdmin).toBe(admin)
    expect(sdk.createUnlinkClient).toBe(client)
  })

  it('finds a binding wherever it actually lives — placement is not hardcoded', async () => {
    rootMissing()
    const client = vi.fn()
    vi.doMock('@unlink-xyz/sdk/crypto', () => ({
      account: { fromEthereumSignature: vi.fn(), fromKeys: vi.fn() },
      buildDeriveSeedMessage: vi.fn(),
    }))
    // `createUnlinkClient`'s home is UNCONFIRMED; here it turns up on /admin
    // rather than the guessed /client, and /client does not resolve at all.
    vi.doMock('@unlink-xyz/sdk/admin', () => ({
      createUnlinkAdmin: vi.fn(),
      createUnlinkClient: client,
    }))
    vi.doMock('@unlink-xyz/sdk/client', () => {
      throw new Error('no such subpath')
    })

    const { loadUnlinkSdk } = await import('../lib/unlink/loadSdk.js')
    expect((await loadUnlinkSdk()).createUnlinkClient).toBe(client)
  })

  it('treats a PARTIAL surface as no surface — fail before a money path, not inside one', async () => {
    rootMissing()
    vi.doMock('@unlink-xyz/sdk/crypto', () => ({
      account: { fromEthereumSignature: vi.fn(), fromKeys: vi.fn() },
      buildDeriveSeedMessage: vi.fn(),
    }))
    vi.doMock('@unlink-xyz/sdk/admin', () => ({ createUnlinkAdmin: vi.fn() }))
    // createUnlinkClient is nowhere — the withdraw leg would have failed later.

    const { loadUnlinkSdk, UnlinkSdkUnavailableError } = await import('../lib/unlink/loadSdk.js')
    await expect(loadUnlinkSdk()).rejects.toBeInstanceOf(UnlinkSdkUnavailableError)
  })

  it('reports the package absent when neither the root nor any subpath resolves', async () => {
    rootMissing()
    for (const s of SPECIFIERS.slice(1)) {
      vi.doMock(s, () => {
        throw new Error(`Cannot find module '${s}'`)
      })
    }
    const { loadUnlinkSdk, UnlinkSdkUnavailableError } = await import('../lib/unlink/loadSdk.js')
    const caught = await loadUnlinkSdk().catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(UnlinkSdkUnavailableError)
    expect((caught as { recoverable: boolean }).recoverable).toBe(true)
    expect((caught as { code: string }).code).toBe('unlink_sdk_unavailable')
  })
})

describe('loadUnlinkSdk — the fake shielded set is opt-in and never implicit', () => {
  it('is NOT used when the flag is unset, even with no real package present', async () => {
    rootMissing()
    const { loadUnlinkSdk, UnlinkSdkUnavailableError } = await import('../lib/unlink/loadSdk.js')
    await expect(loadUnlinkSdk()).rejects.toBeInstanceOf(UnlinkSdkUnavailableError)
  })

  it('is selected ahead of everything when explicitly flagged on', async () => {
    process.env.UNLINK_FAKE_SDK = 'true'
    const rootProbe = vi.fn()
    vi.doMock('@unlink-xyz/sdk', () => {
      rootProbe()
      return { account: {}, buildDeriveSeedMessage: vi.fn(), createUnlinkAdmin: vi.fn(), createUnlinkClient: vi.fn() }
    })

    const { loadUnlinkSdk } = await import('../lib/unlink/loadSdk.js')
    const sdk = await loadUnlinkSdk()
    // The real package is never consulted — the fake short-circuits first, so a
    // developer running with the flag can never half-use a real SDK by accident.
    expect(rootProbe).not.toHaveBeenCalled()
    expect(typeof sdk.createUnlinkClient).toBe('function')
    expect(sdk.buildDeriveSeedMessage({ appId: 'a', chainId: 5042002 })).toContain('5042002')
  })

  it('binds the derived account to appId AND chainId, so a chain switch is not silent', async () => {
    process.env.UNLINK_FAKE_SDK = 'true'
    const { loadUnlinkSdk } = await import('../lib/unlink/loadSdk.js')
    const sdk = await loadUnlinkSdk()
    const onArc = sdk.buildDeriveSeedMessage({ appId: 'app-1', chainId: 5042002 })
    const onBase = sdk.buildDeriveSeedMessage({ appId: 'app-1', chainId: 84532 })
    // Different chain ⇒ different seed message ⇒ a DIFFERENT account. This is the
    // property that makes the Arc-locked derivation a real (documented) risk.
    expect(onArc).not.toBe(onBase)
  })
})
