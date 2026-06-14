/**
 * @file blink.test.ts — the one-tap deposit funding seam (env-gated, fail-soft).
 *
 * Pins:
 *   - UNCONFIGURED ⇒ `runBlinkDeposit` returns `not_configured` and NEVER probes
 *     the SDK (no funds, no throw).
 *   - CONFIGURED but the SDK is ABSENT ⇒ `deposit_sdk_unavailable` (fail-soft, no
 *     funds moved) — the loadSdk no-op path, exactly like the Unlink private leg.
 *   - the loader throws a recoverable, secret-free error when the package is gone.
 *   - CONFIGURED + an injected SDK ⇒ the deposit runs and the result is surfaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isBlinkConfigured,
  isBlinkEnabled,
  isBlinkPublicConfigured,
  runBlinkDeposit,
} from '../blink'
import {
  DepositSdkUnavailableError,
  loadDepositSdk,
  type DepositSdk,
} from '../loadSdk'

const BLINK_ENV = [
  'BLINK_ENABLED',
  'NEXT_PUBLIC_BLINK_APP_ID',
  'NEXT_PUBLIC_BLINK_TOKEN',
  'NEXT_PUBLIC_BLINK_CHAIN_ID',
  'NEXT_PUBLIC_DEFAULT_CHAIN_ID',
] as const

function clearBlinkEnv(): void {
  for (const k of BLINK_ENV) delete process.env[k]
}

const ADDR = ('0x' + '33'.repeat(20)) as `0x${string}`

beforeEach(clearBlinkEnv)
afterEach(clearBlinkEnv)

describe('config gating', () => {
  it('disabled + no app id ⇒ unconfigured', () => {
    expect(isBlinkEnabled()).toBe(false)
    expect(isBlinkConfigured()).toBe(false)
    expect(isBlinkPublicConfigured()).toBe(false)
  })

  it('BLINK_ENABLED alone is NOT enough — needs a public app id', () => {
    process.env.BLINK_ENABLED = 'true'
    expect(isBlinkEnabled()).toBe(true)
    expect(isBlinkConfigured()).toBe(false)
  })

  it('enabled + app id ⇒ fully configured; public check sees only the app id', () => {
    process.env.BLINK_ENABLED = 'true'
    process.env.NEXT_PUBLIC_BLINK_APP_ID = 'blink-app-1'
    expect(isBlinkConfigured()).toBe(true)
    expect(isBlinkPublicConfigured()).toBe(true)
  })
})

describe('runBlinkDeposit — fail-soft, never throws', () => {
  it('UNCONFIGURED ⇒ not_configured WITHOUT probing the SDK', async () => {
    // Inject a loader that would FAIL the test if called — proves no SDK probe.
    const loadSdk = vi.fn<() => Promise<DepositSdk>>()
    const r = await runBlinkDeposit({ amount: '5.00', address: ADDR, chainId: 84532 }, loadSdk)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_configured')
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('CONFIGURED but SDK ABSENT ⇒ deposit_sdk_unavailable (no funds moved)', async () => {
    process.env.BLINK_ENABLED = 'true'
    process.env.NEXT_PUBLIC_BLINK_APP_ID = 'blink-app-1'
    const loadSdk = vi.fn(async () => {
      throw new DepositSdkUnavailableError()
    })
    const r = await runBlinkDeposit({ amount: '5.00', address: ADDR, chainId: 84532 }, loadSdk)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('deposit_sdk_unavailable')
    expect(loadSdk).toHaveBeenCalledOnce()
  })

  it('CONFIGURED + an injected SDK ⇒ runs the deposit and surfaces the result', async () => {
    process.env.BLINK_ENABLED = 'true'
    process.env.NEXT_PUBLIC_BLINK_APP_ID = 'blink-app-1'
    const requestDeposit = vi.fn(async () => ({ status: 'completed' as const, txHash: ADDR }))
    const loadSdk = async (): Promise<DepositSdk> => ({ requestDeposit })
    const r = await runBlinkDeposit({ amount: '5.00', address: ADDR, chainId: 84532 }, loadSdk)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.status).toBe('completed')
    // The destination address + amount + chain rode through to the SDK unchanged.
    expect(requestDeposit).toHaveBeenCalledWith({
      amount: '5.00',
      address: ADDR,
      chainId: 84532,
      token: 'USDC',
    })
  })

  it('a thrown SDK error fails soft as deposit_failed (clean reason, no throw)', async () => {
    process.env.BLINK_ENABLED = 'true'
    process.env.NEXT_PUBLIC_BLINK_APP_ID = 'blink-app-1'
    const loadSdk = async (): Promise<DepositSdk> => ({
      requestDeposit: vi.fn(async () => {
        throw new Error('user cancelled')
      }),
    })
    const r = await runBlinkDeposit({ amount: '5.00', address: ADDR, chainId: 84532 }, loadSdk)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('deposit_failed')
  })
})

describe('loadDepositSdk no-op (package absent off a clean main)', () => {
  it('throws a recoverable, secret-free DepositSdkUnavailableError', async () => {
    // The package is NOT installed in this repo; the dynamic import must reject,
    // and the loader must wrap it in the fail-soft error.
    await expect(loadDepositSdk()).rejects.toBeInstanceOf(DepositSdkUnavailableError)
    try {
      await loadDepositSdk()
    } catch (err) {
      expect(err).toBeInstanceOf(DepositSdkUnavailableError)
      const e = err as DepositSdkUnavailableError
      expect(e.recoverable).toBe(true)
      expect(e.code).toBe('deposit_sdk_unavailable')
      // No secret, no guessed address in the message.
      expect(e.message).not.toMatch(/0x[0-9a-fA-F]{40}/)
    }
  })
})
