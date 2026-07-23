/**
 * @file register-form-ens.test.ts
 *
 * Tests for the ENS fee-recipient resolution behaviour added to RegisterForm.
 *
 * Because RegisterForm uses hooks and the Dynamic wallet context we test the
 * underlying resolution helpers — resolveENS / isEnsInput / EnsResolutionError
 * — in the exact way the form exercises them, verifying:
 *   - an ENS name (*.eth, DNS import) is treated as ENS input
 *   - a valid 0x address is passed through unchanged with NO network call
 *   - a successful resolution returns the address
 *   - a null / zero-address resolution throws EnsResolutionError (fail-soft law)
 *   - the human-readable error message is the one the form would display
 *   - the settlement chain id is forwarded correctly (ENSIP-11)
 *
 * The network layer is mocked via vi.mock (the ens.test.ts precedent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock viem's client factory ──────────────────────────────────────────────
const getEnsAddress = vi.fn()
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ getEnsAddress })),
  }
})

import {
  EnsResolutionError,
  isEnsInput,
  resolveENS,
  toCoinType,
} from '../lib/ens'

const VALID_ADDR = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B' as const
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const
const CHAIN_ID = 5042002 // Arc Testnet — a supported settlement chain

beforeEach(() => {
  getEnsAddress.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── isEnsInput — the gate the form uses to decide whether to resolve ────────

describe('isEnsInput (form gate)', () => {
  it('identifies .eth names as ENS input', () => {
    expect(isEnsInput('alice.eth')).toBe(true)
    expect(isEnsInput('fees.alice.eth')).toBe(true)
  })

  it('identifies DNS-import names as ENS input', () => {
    expect(isEnsInput('partner.xyz')).toBe(true)
    expect(isEnsInput('fees.company.io')).toBe(true)
  })

  it('does NOT treat a plain 0x address as ENS input', () => {
    expect(isEnsInput(VALID_ADDR)).toBe(false)
  })

  it('does NOT treat a label without a dot as ENS input', () => {
    expect(isEnsInput('alice')).toBe(false)
    expect(isEnsInput('')).toBe(false)
  })
})

// ── resolveENS — 0x pass-through (no network call) ──────────────────────────

describe('resolveENS — 0x address pass-through', () => {
  it('returns a valid 0x address unchanged without hitting the network', async () => {
    const out = await resolveENS(VALID_ADDR, CHAIN_ID)
    expect(out).toBe(VALID_ADDR)
    expect(getEnsAddress).not.toHaveBeenCalled()
  })
})

// ── resolveENS — successful ENS resolution ───────────────────────────────────

describe('resolveENS — successful resolution', () => {
  it('resolves alice.eth to an address on the settlement chain', async () => {
    getEnsAddress.mockResolvedValue(VALID_ADDR)
    const out = await resolveENS('alice.eth', CHAIN_ID)
    expect(out).toBe(VALID_ADDR)
    expect(getEnsAddress).toHaveBeenCalledTimes(1)
  })

  it('passes the ENSIP-11 coinType for an L2 settlement chain', async () => {
    getEnsAddress.mockResolvedValue(VALID_ADDR)
    await resolveENS('fees.eth', CHAIN_ID)
    const arg = getEnsAddress.mock.calls[0]?.[0]
    expect(arg?.coinType).toBe(BigInt(toCoinType(CHAIN_ID)))
  })

  it('does NOT pass a coinType for mainnet (uses ENS default 60)', async () => {
    getEnsAddress.mockResolvedValue(VALID_ADDR)
    await resolveENS('fees.eth', 1)
    const arg = getEnsAddress.mock.calls[0]?.[0]
    expect(arg?.coinType).toBeUndefined()
  })

  it('resolves a DNS-import name (not just .eth)', async () => {
    getEnsAddress.mockResolvedValue(VALID_ADDR)
    const out = await resolveENS('partner.company.xyz', CHAIN_ID)
    expect(out).toBe(VALID_ADDR)
  })
})

// ── resolveENS — fail-soft (null / zero ⇒ throw, never swallow) ─────────────

describe('resolveENS — fail-soft on unresolvable names', () => {
  it('throws EnsResolutionError when the name resolves to null', async () => {
    getEnsAddress.mockResolvedValue(null)
    await expect(resolveENS('nobody.eth', CHAIN_ID)).rejects.toBeInstanceOf(
      EnsResolutionError,
    )
  })

  it('throws EnsResolutionError when the name resolves to the zero address', async () => {
    getEnsAddress.mockResolvedValue(ZERO_ADDR)
    await expect(resolveENS('nobody.eth', CHAIN_ID)).rejects.toBeInstanceOf(
      EnsResolutionError,
    )
  })

  it('EnsResolutionError carries the name and chainId for the form to display', async () => {
    getEnsAddress.mockResolvedValue(null)
    let caught: unknown
    try {
      await resolveENS('nobody.eth', CHAIN_ID)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnsResolutionError)
    const e = caught as EnsResolutionError
    expect(e.ensName).toBe('nobody.eth')
    expect(e.chainId).toBe(CHAIN_ID)
    expect(e.message).toContain('nobody.eth')
    expect(e.message).toContain(String(CHAIN_ID))
  })

  it('throws EnsResolutionError for junk input (no dot, not an address)', async () => {
    await expect(resolveENS('notaname', CHAIN_ID)).rejects.toBeInstanceOf(
      EnsResolutionError,
    )
    // No network call was made — the guard fires first.
    expect(getEnsAddress).not.toHaveBeenCalled()
  })
})

// ── form-level message construction ─────────────────────────────────────────
// Mirror the exact message the form builds from an EnsResolutionError so the
// contract between lib and component is pinned.

describe('form error message construction from EnsResolutionError', () => {
  function buildFormMessage(input: string, err: unknown): string {
    if (err instanceof EnsResolutionError) {
      return `Could not resolve "${input}" — make sure the name is correct and has an address set for this chain.`
    }
    if (err instanceof Error) {
      return `ENS resolution failed: ${err.message}`
    }
    return 'ENS resolution failed.'
  }

  it('produces the expected human-readable message for EnsResolutionError', async () => {
    getEnsAddress.mockResolvedValue(null)
    let err: unknown
    try {
      await resolveENS('nobody.eth', CHAIN_ID)
    } catch (e) {
      err = e
    }
    const msg = buildFormMessage('nobody.eth', err)
    expect(msg).toContain('Could not resolve "nobody.eth"')
    expect(msg).toContain('make sure the name is correct')
  })

  it('produces a generic message for non-ENS errors', () => {
    const msg = buildFormMessage('name.eth', new Error('network timeout'))
    expect(msg).toBe('ENS resolution failed: network timeout')
  })

  it('produces the fallback message for non-Error throws', () => {
    const msg = buildFormMessage('name.eth', 'string error')
    expect(msg).toBe('ENS resolution failed.')
  })
})
