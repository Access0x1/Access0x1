/**
 * registrar.test.ts — the .eth purchase seam: env gate, label rules, money math.
 *
 * Every wrong ordering or drifted argument in commit/reveal costs the BUYER gas
 * on a guaranteed revert, so these tests pin the client-side rules that keep a
 * doomed transaction from ever being offered.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_REGISTRATION_SECONDS,
  MIN_REGISTRATION_SECONDS,
  buildCommitTx,
  buildRegisterTx,
  checkAvailable,
  clampDuration,
  commitmentWindow,
  isRegistrarConfigured,
  makeCommitment,
  quoteRent,
  randomSecret,
  registerValue,
  registrarConfig,
  registrationArgs,
  validateLabel,
} from '../registrar'

const CONTROLLER = '0x253553366Da8546fC250F225fe3d25d0C782303b'
const RESOLVER = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD'
const OWNER = '0x1111111111111111111111111111111111111111'
const ZERO = '0x0000000000000000000000000000000000000000'

const CFG = { controller: CONTROLLER, chainId: 11155111, resolver: RESOLVER } as ReturnType<
  typeof registrarConfig
> & { controller: `0x${string}` }

function params(overrides: Partial<Parameters<typeof registrationArgs>[0]> = {}) {
  return {
    label: 'acme',
    owner: OWNER as `0x${string}`,
    durationSeconds: BigInt(DEFAULT_REGISTRATION_SECONDS),
    secret: `0x${'ab'.repeat(32)}` as `0x${string}`,
    resolver: RESOLVER as `0x${string}`,
    data: [] as `0x${string}`[],
    reverseRecord: true,
    ...overrides,
  }
}

describe('registrarConfig (the env gate — law 1 + law 3)', () => {
  it('is OFF with no controller configured — the UI never shows Buy', () => {
    expect(registrarConfig({})).toBeNull()
    expect(isRegistrarConfigured({})).toBe(false)
  })

  it('is OFF with a malformed controller address', () => {
    expect(registrarConfig({ NEXT_PUBLIC_ENS_REGISTRAR_CONTROLLER: 'not-an-address' })).toBeNull()
  })

  it('defaults to Sepolia (testnet-only law) and zero resolver when unset', () => {
    const cfg = registrarConfig({ NEXT_PUBLIC_ENS_REGISTRAR_CONTROLLER: CONTROLLER })
    expect(cfg?.chainId).toBe(11155111)
    expect(cfg?.resolver).toBe(ZERO)
  })

  it('honors explicit chain id + resolver + rpc url', () => {
    const cfg = registrarConfig({
      NEXT_PUBLIC_ENS_REGISTRAR_CONTROLLER: CONTROLLER,
      NEXT_PUBLIC_ENS_REGISTRAR_CHAIN_ID: '17000',
      NEXT_PUBLIC_ENS_REGISTRAR_RESOLVER: RESOLVER,
      NEXT_PUBLIC_ENS_REGISTRAR_RPC_URL: 'https://rpc.example',
    })
    expect(cfg).toMatchObject({ chainId: 17000, resolver: RESOLVER, rpcUrl: 'https://rpc.example' })
  })
})

describe('validateLabel (ENSIP-15 + .eth registrar rules)', () => {
  it('normalizes case and strips a trailing .eth', () => {
    expect(validateLabel('  AcMe.eth ')).toEqual({ ok: true, label: 'acme' })
  })
  it('rejects empty, dotted, and sub-3-char labels', () => {
    expect(validateLabel('')).toEqual({ ok: false, problem: 'empty' })
    expect(validateLabel('a.b')).toEqual({ ok: false, problem: 'contains_dot' })
    expect(validateLabel('ab')).toEqual({ ok: false, problem: 'too_short' })
  })
  it('rejects labels ENSIP-15 cannot normalize', () => {
    const res = validateLabel('ab͸cd') // U+0378: unassigned, disallowed by ENSIP-15
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.problem).toBe('not_normalizable')
  })
})

describe('money math', () => {
  it('register value = quote + 5% refundable buffer', () => {
    expect(registerValue(1000n)).toBe(1050n)
  })
  it('duration clamps to the controller minimum (28 days)', () => {
    expect(clampDuration(60)).toBe(BigInt(MIN_REGISTRATION_SECONDS))
    expect(clampDuration(DEFAULT_REGISTRATION_SECONDS)).toBe(BigInt(DEFAULT_REGISTRATION_SECONDS))
  })
})

describe('registrationArgs (one source for BOTH transactions)', () => {
  it('bare registration (zero resolver) forbids records and reverseRecord', () => {
    expect(() =>
      registrationArgs(params({ resolver: ZERO as `0x${string}`, reverseRecord: true })),
    ).toThrow(/resolver/)
    expect(() =>
      registrationArgs(params({ resolver: ZERO as `0x${string}`, reverseRecord: false, data: ['0x1234'] as `0x${string}`[] })),
    ).toThrow(/resolver/)
  })
  it('fuses are always 0 — we never restrict the buyer’s own name', () => {
    const args = registrationArgs(params())
    expect(args[7]).toBe(0)
  })
  it('commit and register are built from the SAME argument tuple', async () => {
    const p = params()
    const client = {
      readContract: vi.fn().mockResolvedValue(`0x${'cd'.repeat(32)}`),
    }
    const commitment = await makeCommitment(client, CFG, p)
    const commitTx = buildCommitTx(CFG, commitment)
    const registerTx = buildRegisterTx(CFG, p, 1050n)
    // the contract computed the commitment from exactly the register args
    expect(client.readContract.mock.calls[0]?.[0]?.args).toEqual(registerTx.args)
    expect(commitTx.args).toEqual([commitment])
    expect(registerTx.value).toBe(1050n)
  })
})

describe('controller reads (injected client — offline)', () => {
  it('checkAvailable + quoteRent pass through with buffered value', async () => {
    const client = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(true) // available
        .mockResolvedValueOnce({ base: 900n, premium: 100n }), // rentPrice
    }
    expect(await checkAvailable(client, CFG, 'acme')).toBe(true)
    const quote = await quoteRent(client, CFG, 'acme', 1000n)
    expect(quote).toEqual({ baseWei: 900n, premiumWei: 100n, totalWei: 1000n, valueWei: 1050n })
  })

  it('commitmentWindow falls back to the deployed 60s/24h on read failure', async () => {
    const client = { readContract: vi.fn().mockRejectedValue(new Error('rpc down')) }
    expect(await commitmentWindow(client, CFG)).toEqual({ minAgeS: 60, maxAgeS: 86400 })
  })
})

describe('randomSecret', () => {
  it('is 32 bytes of hex and never repeats', () => {
    const a = randomSecret()
    const b = randomSecret()
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})
