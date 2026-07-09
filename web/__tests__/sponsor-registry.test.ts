/**
 * @file sponsor-registry.test.ts — the sponsor record's fail-soft read + the
 * per-chain address resolution.
 *
 * The registry's CREATE3 mirror address is COMPUTED BUT DEPLOYED NOWHERE yet,
 * so the load-bearing honesty lives in `readSponsorState`'s tri-state:
 *   - no code at the address  ⇒ { deployed: false } — "not on this chain yet",
 *   - code + readable record  ⇒ { deployed: true, sponsor, pending } (0x0 ⇒ null),
 *   - ANY RPC error           ⇒ the DISTINCT { deployed: null } unknown state.
 * It must never throw to the UI and never conflate "unreachable" with
 * "not deployed" (a blip must not render the muted not-here card, and a
 * missing deployment must never render as an empty-but-live record).
 *
 * Address resolution mirrors the router pattern (mirror-default.test.ts):
 * env override per chain, CREATE3 mirror as the zero-config default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'
import {
  getSponsorRegistryAddress,
  MIRROR_SPONSOR_REGISTRY_ADDRESS,
  readSponsorState,
} from '../lib/sponsor-registry.js'

const ZERO = '0x0000000000000000000000000000000000000000'
const SPONSOR = '0x00000000000000000000000000000000000000aa'
const PENDING = '0x00000000000000000000000000000000000000bb'

/** A fake viem PublicClient exposing just the surface readSponsorState touches. */
function fakeClient(opts: {
  /** Bytecode getCode resolves ('0x'/undefined = no code), or an Error to throw. */
  code?: string | Error
  /** sponsorOf / pendingSponsorOf results, or an Error to throw on reads. */
  sponsor?: string
  pending?: string
  readError?: Error
}): PublicClient {
  const getCode = vi.fn(async () => {
    if (opts.code instanceof Error) throw opts.code
    return opts.code
  })
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (opts.readError) throw opts.readError
    if (functionName === 'sponsorOf') return opts.sponsor ?? ZERO
    if (functionName === 'pendingSponsorOf') return opts.pending ?? ZERO
    throw new Error(`unexpected read: ${functionName}`)
  })
  return { getCode, readContract } as unknown as PublicClient
}

describe('readSponsorState — the three honest shapes', () => {
  it('no code at the address ⇒ deployed:false (registry not on this chain yet)', async () => {
    for (const code of ['0x', undefined]) {
      const state = await readSponsorState(fakeClient({ code }), 5042002, 1n)
      expect(state).toEqual({ deployed: false, sponsor: null, pending: null })
    }
  })

  it('deployed, nothing recorded ⇒ deployed:true with both nulls (0x0 is never an address)', async () => {
    const state = await readSponsorState(fakeClient({ code: '0x6001' }), 5042002, 1n)
    expect(state).toEqual({ deployed: true, sponsor: null, pending: null })
  })

  it('deployed with a pending offer ⇒ pending set, sponsor null (NOT connected)', async () => {
    const state = await readSponsorState(
      fakeClient({ code: '0x6001', pending: PENDING }),
      5042002,
      7n,
    )
    expect(state.deployed).toBe(true)
    expect(state.sponsor).toBeNull()
    expect(state.pending).toBe(PENDING)
  })

  it('deployed with an accepted sponsor ⇒ sponsor set (THE record)', async () => {
    const state = await readSponsorState(
      fakeClient({ code: '0x6001', sponsor: SPONSOR }),
      84532,
      7n,
    )
    expect(state.deployed).toBe(true)
    expect(state.sponsor).toBe(SPONSOR)
  })

  it('getCode RPC failure ⇒ the DISTINCT deployed:null unknown state, never a throw', async () => {
    const state = await readSponsorState(
      fakeClient({ code: new Error('fetch failed') }),
      5042002,
      1n,
    )
    expect(state).toEqual({ deployed: null, sponsor: null, pending: null })
  })

  it('code present but the reads fail ⇒ deployed:null too (never a fabricated empty record)', async () => {
    const state = await readSponsorState(
      fakeClient({ code: '0x6001', readError: new Error('execution reverted') }),
      5042002,
      1n,
    )
    expect(state).toEqual({ deployed: null, sponsor: null, pending: null })
  })
})

describe('getSponsorRegistryAddress — mirror default + env override', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SPONSOR_REGISTRY_ADDRESS_5042002
    delete process.env.NEXT_PUBLIC_SPONSOR_REGISTRY_ADDRESS_43113
  })

  it('defaults to the CREATE3 mirror proxy on every chain (computed-not-yet-deployed; getCode gates honesty)', () => {
    for (const id of [5042002, 84532, 43113, 999999]) {
      expect(getSponsorRegistryAddress(id)).toBe(MIRROR_SPONSOR_REGISTRY_ADDRESS)
    }
  })

  it('lets a per-chain env override win over the mirror default', () => {
    // A non-literal-map id reads the computed server-side key at call time
    // (the mirror-default.test.ts precedent).
    const override = '0x00000000000000000000000000000000000000cc'
    process.env.NEXT_PUBLIC_SPONSOR_REGISTRY_ADDRESS_43113 = override
    expect(getSponsorRegistryAddress(43113)).toBe(override)
  })
})
