/**
 * @file live-chain.test.ts — the live-chain layer's resolution + write guard.
 *
 * The stale-network defect this layer fixes: merchant surfaces resolved the
 * router from the build-time default chain while the write submitted on the
 * wallet's ACTUAL chain. These tests pin the two halves of the fix:
 *
 *   1. `resolveLiveChain` — everything derives from the LIVE chain id, and an
 *      unsupported chain fail-softs to `{ isSupported: false, routerAddress:
 *      null }` — NEVER a wrong-chain address. Including the adversarial case:
 *      a chain the CREATE3 mirror is deployed to but that is NOT one of the
 *      app's SUPPORTED_CHAINS must still resolve null.
 *   2. `ensureChain` — the generalized AdminPanel prepareWallet: no-ops when
 *      the wallet already sits on the target, switches when it doesn't, and
 *      THROWS when the switch is rejected or doesn't land.
 *
 * `useLiveChain` itself is probed through React's static server renderer with
 * wagmi mocked (the DashboardView/OnboardView precedent) — wallet chain wins
 * when connected, config chain is the disconnected display fallback.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WalletClient } from 'viem'
import { mainnet } from 'viem/chains'

// ── mock wagmi (mutable state the probe tests drive) ────────────────────────
const wagmiState = {
  account: { chainId: undefined as number | undefined, isConnected: false },
  configChainId: 5042002,
}
vi.mock('wagmi', () => ({
  useAccount: () => wagmiState.account,
  useChainId: () => wagmiState.configChainId,
}))

const { ensureChain, isTestnetChain, resolveLiveChain, useLiveChain, writableChains } =
  await import('../lib/live-chain')
const {
  ARC_TESTNET_USDC_ADDRESS,
  BASE_SEPOLIA_USDC_ADDRESS,
  MIRROR_ROUTER_ADDRESS,
  SUPPORTED_CHAINS,
} = await import('../lib/chains')

// ── resolveLiveChain — per-chain resolution + fail-soft nulls ───────────────

describe('resolveLiveChain — supported chains', () => {
  it('Arc Testnet (the lead chain): mirror router + native USDC', () => {
    const live = resolveLiveChain(5042002)
    expect(live.chainId).toBe(5042002)
    expect(live.chain?.name).toBe('Arc Testnet')
    expect(live.isSupported).toBe(true)
    expect(live.routerAddress).toBe(MIRROR_ROUTER_ADDRESS)
    expect(live.usdcAddress).toBe(ARC_TESTNET_USDC_ADDRESS)
  })

  it('Base Sepolia: mirror router + canonical USDC both resolve zero-config', () => {
    const live = resolveLiveChain(84532)
    expect(live.isSupported).toBe(true)
    expect(live.routerAddress).toBe(MIRROR_ROUTER_ADDRESS)
    // No NEXT_PUBLIC_USDC_ADDRESS_84532 in the test env — Base Sepolia now
    // resolves Circle's canonical testnet USDC as its zero-config default (a
    // public chain fact, verified allowlisted + quotable on the live mirror
    // router), the same carve-out as Arc. Still never a guessed/wrong-chain
    // address — an env value overrides, and non-defaulted chains stay null.
    expect(live.usdcAddress).toBe(BASE_SEPOLIA_USDC_ADDRESS)
  })

  it('a supported checkout chain with NO router (zkSync Sepolia, not mirrored, no env) is not writable', () => {
    const live = resolveLiveChain(300)
    expect(live.chain).not.toBeNull() // we know the chain…
    expect(live.isSupported).toBe(false) // …but no merchant write can land on it
    expect(live.routerAddress).toBeNull()
  })
})

describe('resolveLiveChain — fail-soft on everything else', () => {
  it('a mirror-deployed chain OUTSIDE SUPPORTED_CHAINS still resolves null (never wrong-chain)', () => {
    // Ethereum Sepolia (11155111) is in MIRROR_SUPPORTED_CHAIN_IDS but is NOT
    // one of the app's supported chains — the resolver must not hand out the
    // mirror address for a chain the app can't otherwise handle.
    const live = resolveLiveChain(11155111)
    expect(live.chain).toBeNull()
    expect(live.isSupported).toBe(false)
    expect(live.routerAddress).toBeNull()
    expect(live.usdcAddress).toBeNull()
  })

  it('an unknown chain id resolves nulls', () => {
    const live = resolveLiveChain(999999)
    expect(live).toMatchObject({
      chainId: 999999,
      chain: null,
      isSupported: false,
      routerAddress: null,
      usdcAddress: null,
    })
  })

  it('no chain id at all resolves the empty state', () => {
    for (const id of [null, undefined]) {
      const live = resolveLiveChain(id)
      expect(live).toMatchObject({
        chainId: null,
        chain: null,
        isSupported: false,
        routerAddress: null,
        usdcAddress: null,
      })
    }
  })
})

describe('isTestnetChain + writableChains', () => {
  it('every SUPPORTED_CHAINS entry is a testnet; viem mainnet is not', () => {
    for (const chain of SUPPORTED_CHAINS) {
      expect(isTestnetChain(chain)).toBe(true)
    }
    expect(isTestnetChain(mainnet)).toBe(false)
  })

  it('writableChains = supported ∩ router-resolvable (mirror chains in, router-less out)', () => {
    const ids = writableChains().map((c) => c.id)
    expect(ids).toContain(5042002) // Arc
    expect(ids).toContain(84532) // Base Sepolia
    expect(ids).toContain(43113) // Avalanche Fuji
    expect(ids).not.toContain(300) // zkSync Sepolia — no router in this env
    expect(ids).not.toContain(11155111) // not a supported app chain at all
  })
})

// ── ensureChain — the switch-or-throw write guard ───────────────────────────

/** A fake viem WalletClient with just the surface ensureChain touches. */
function fakeWalletClient(opts: {
  chainId?: number
  liveChainIds: number[]
  switchChain?: (args: { id: number }) => Promise<void>
}): {
  client: WalletClient
  switchChain: ReturnType<typeof vi.fn>
  getChainId: ReturnType<typeof vi.fn>
} {
  const liveIds = [...opts.liveChainIds]
  const getChainId = vi.fn(async () => {
    // Yield the queued live chain readings in order (last one sticks).
    return liveIds.length > 1 ? (liveIds.shift() as number) : liveIds[0]
  })
  const switchChain = vi.fn(opts.switchChain ?? (async () => {}))
  const client = {
    chain: opts.chainId === undefined ? undefined : { id: opts.chainId },
    getChainId,
    switchChain,
  } as unknown as WalletClient
  return { client, switchChain, getChainId }
}

describe('ensureChain', () => {
  it('no-ops (no switch prompt) when the wallet is already on the target chain', async () => {
    const { client, switchChain } = fakeWalletClient({ chainId: 84532, liveChainIds: [84532] })
    await expect(ensureChain(client, 84532)).resolves.toBe(false)
    expect(switchChain).not.toHaveBeenCalled()
  })

  it('reads the live chain from the transport when the client has no chain snapshot', async () => {
    const { client, switchChain, getChainId } = fakeWalletClient({
      liveChainIds: [5042002],
    })
    await expect(ensureChain(client, 5042002)).resolves.toBe(false)
    expect(getChainId).toHaveBeenCalled()
    expect(switchChain).not.toHaveBeenCalled()
  })

  it('switches when mismatched and verifies the wallet actually landed', async () => {
    // Wallet starts on Base Sepolia; after the switch the transport reads Arc.
    const { client, switchChain } = fakeWalletClient({
      chainId: 84532,
      liveChainIds: [5042002],
    })
    await expect(ensureChain(client, 5042002)).resolves.toBe(true)
    expect(switchChain).toHaveBeenCalledWith({ id: 5042002 })
  })

  it('throws when the wallet rejects the switch (the write must never proceed)', async () => {
    const { client } = fakeWalletClient({
      chainId: 84532,
      liveChainIds: [84532],
      switchChain: async () => {
        throw new Error('User rejected the request.')
      },
    })
    await expect(ensureChain(client, 5042002)).rejects.toThrow('User rejected the request.')
  })

  it('throws when the switch "succeeds" but the wallet is still on another chain', async () => {
    // switchChain resolves but the transport still reads the old chain.
    const { client } = fakeWalletClient({ chainId: 84532, liveChainIds: [84532] })
    await expect(ensureChain(client, 5042002)).rejects.toThrow(/did not switch to chain 5042002/)
  })
})

// ── useLiveChain — the wagmi binding (SSR probe, mocked wagmi) ──────────────

function Probe(): ReactElement {
  const live = useLiveChain()
  return createElement('div', {
    'data-chain-id': String(live.chainId),
    'data-supported': String(live.isSupported),
    'data-router': String(live.routerAddress),
    'data-connected': String(live.isConnected),
  })
}

function renderProbe(): string {
  return renderToStaticMarkup(createElement(Probe))
}

describe('useLiveChain — wallet chain wins, config chain is the fallback', () => {
  it('connected: resolves the WALLET’S chain, not the config default', () => {
    wagmiState.account = { chainId: 43113, isConnected: true }
    wagmiState.configChainId = 5042002
    const html = renderProbe()
    expect(html).toContain('data-chain-id="43113"')
    expect(html).toContain('data-supported="true"')
    expect(html).toContain('data-connected="true"')
  })

  it('connected on an app-unknown chain: unsupported, router null (the defect case)', () => {
    wagmiState.account = { chainId: 1, isConnected: true }
    const html = renderProbe()
    expect(html).toContain('data-chain-id="1"')
    expect(html).toContain('data-supported="false"')
    expect(html).toContain('data-router="null"')
  })

  it('disconnected: falls back to the wagmi config chain for display', () => {
    wagmiState.account = { chainId: undefined, isConnected: false }
    wagmiState.configChainId = 5042002
    const html = renderProbe()
    expect(html).toContain('data-chain-id="5042002"')
    expect(html).toContain('data-connected="false"')
  })
})
