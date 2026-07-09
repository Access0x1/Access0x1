/**
 * @file sponsor-panel.test.tsx — the sponsor status panel's five states +
 * role-gated buttons.
 *
 * SponsorPanelView is the pure presentational half (the NetworkBadgeView
 * precedent), so every state renders deterministically under React's static
 * server renderer:
 *   - not-deployed — muted "isn't deployed on <chain> yet", NO buttons (the
 *     registry's mirror address is computed but deployed nowhere — the panel
 *     must never fake a green);
 *   - unknown      — "couldn't reach" + Retry (distinct from not-deployed);
 *   - none         — warn-accented outstanding action; ONLY a non-owner wallet
 *     sees "Offer to sponsor this business" (offers are inert two-step consent);
 *   - pending      — owner sees Accept/Decline, the pending sponsor sees
 *     Withdraw, a stranger sees no actions;
 *   - connected    — green record; Clear only for the owner or the sponsor.
 * The container is mocked-hermetic (wagmi + Dynamic) and, with effects never
 * firing in SSR, must render the loading skeleton — never a status claim.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SponsorState } from '../lib/sponsor-registry.js'

vi.mock('wagmi', () => ({
  useAccount: () => ({ chainId: undefined, isConnected: false }),
  useChainId: () => 5042002,
}))

vi.mock('@dynamic-labs/sdk-react-core', () => ({
  useDynamicContext: () => ({ primaryWallet: null }),
}))

const { SponsorPanel, SponsorPanelView } = await import('../components/SponsorPanel')

const SPONSOR = '0x00000000000000000000000000000000000000aa'
const PENDING = '0x00000000000000000000000000000000000000bb'

type Role = {
  connected: boolean
  isOwner: boolean
  isPendingSponsor: boolean
  isSponsor: boolean
}

const STRANGER: Role = { connected: true, isOwner: false, isPendingSponsor: false, isSponsor: false }
const OWNER: Role = { connected: true, isOwner: true, isPendingSponsor: false, isSponsor: false }
const DISCONNECTED: Role = { connected: false, isOwner: false, isPendingSponsor: false, isSponsor: false }

function renderView(state: SponsorState | null, role: Role, stale = false): string {
  return renderToStaticMarkup(
    createElement(SponsorPanelView, {
      chainId: 5042002,
      chainName: 'Arc Testnet',
      merchantId: '7',
      state,
      stale,
      role,
      busy: null,
      error: null,
      txHash: null,
      onAction: () => {},
      onRetry: () => {},
    }),
  )
}

describe('SponsorPanelView — REGISTRY NOT ON THIS CHAIN (deployed:false)', () => {
  it('says so honestly, names the chain, and offers NO buttons (no fake green)', () => {
    const html = renderView({ deployed: false, sponsor: null, pending: null }, STRANGER)
    expect(html).toContain('data-sponsor-panel="not-deployed"')
    expect(html).toContain('isn&#x27;t deployed on Arc Testnet yet')
    expect(html).toContain('gasless sponsorship arrives when it lands')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('Gas sponsor connected')
  })
})

describe('SponsorPanelView — UNKNOWN (deployed:null)', () => {
  it('admits it could not reach the chain and offers Retry — never "not deployed"', () => {
    const html = renderView({ deployed: null, sponsor: null, pending: null }, STRANGER)
    expect(html).toContain('data-sponsor-panel="unknown"')
    expect(html).toContain('Couldn&#x27;t reach Arc Testnet')
    expect(html).toContain('Retry')
    expect(html).not.toContain('isn&#x27;t deployed')
    expect(html).not.toContain('Gas sponsor connected')
  })
})

describe('SponsorPanelView — NOT-YET-WIRED (deployed, no sponsor, no offer)', () => {
  const NONE: SponsorState = { deployed: true, sponsor: null, pending: null }

  it('flags the outstanding action with the share/offer copy', () => {
    const html = renderView(NONE, OWNER)
    expect(html).toContain('data-sponsor-panel="none"')
    expect(html).toContain('No gas sponsor wired')
    expect(html).toContain('Share your merchant id (#7) with a sponsor')
  })

  it('a NON-owner wallet gets the Offer button; the owner does not; disconnected does not', () => {
    expect(renderView(NONE, STRANGER)).toContain('Offer to sponsor this business')
    expect(renderView(NONE, OWNER)).not.toContain('Offer to sponsor this business')
    expect(renderView(NONE, DISCONNECTED)).not.toContain('Offer to sponsor this business')
  })
})

describe('SponsorPanelView — OFFER PENDING (pending != 0)', () => {
  const OFFERED: SponsorState = { deployed: true, sponsor: null, pending: PENDING }

  it('shows the pending sponsor address, not a connected claim', () => {
    const html = renderView(OFFERED, STRANGER)
    expect(html).toContain('data-sponsor-panel="pending"')
    expect(html).toContain('0x0000…00bb')
    expect(html).toContain('awaiting the owner&#x27;s acceptance')
    expect(html).not.toContain('Gas sponsor connected')
  })

  it('the seat owner gets Accept + Decline (and no Withdraw)', () => {
    const html = renderView(OFFERED, OWNER)
    expect(html).toContain('Accept sponsor')
    expect(html).toContain('Decline offer')
    expect(html).not.toContain('Withdraw offer')
  })

  it('the pending sponsor wallet gets Withdraw (and no Accept/Decline)', () => {
    const html = renderView(OFFERED, {
      connected: true,
      isOwner: false,
      isPendingSponsor: true,
      isSponsor: false,
    })
    expect(html).toContain('Withdraw offer')
    expect(html).not.toContain('Accept sponsor')
    expect(html).not.toContain('Decline offer')
  })

  it('a stranger gets no action buttons at all', () => {
    const html = renderView(OFFERED, STRANGER)
    expect(html).not.toContain('Accept sponsor')
    expect(html).not.toContain('Decline offer')
    expect(html).not.toContain('Withdraw offer')
  })
})

describe('SponsorPanelView — CONNECTED (sponsor != 0)', () => {
  const CONNECTED: SponsorState = { deployed: true, sponsor: SPONSOR, pending: null }

  it('shows the green record with the sponsor address', () => {
    const html = renderView(CONNECTED, STRANGER)
    expect(html).toContain('data-sponsor-panel="connected"')
    expect(html).toContain('Gas sponsor connected')
    expect(html).toContain('0x0000…00aa')
  })

  it('Clear is available to the owner and to the sponsor — not to a stranger', () => {
    expect(renderView(CONNECTED, OWNER)).toContain('Clear sponsor')
    expect(
      renderView(CONNECTED, {
        connected: true,
        isOwner: false,
        isPendingSponsor: false,
        isSponsor: true,
      }),
    ).toContain('Clear sponsor')
    expect(renderView(CONNECTED, STRANGER)).not.toContain('Clear sponsor')
    expect(renderView(CONNECTED, DISCONNECTED)).not.toContain('Clear sponsor')
  })

  it('a NEW pending offer under a connected record keeps the record primary and offers owner actions', () => {
    const html = renderView({ deployed: true, sponsor: SPONSOR, pending: PENDING }, OWNER)
    expect(html).toContain('data-sponsor-panel="connected"')
    expect(html).toContain('Gas sponsor connected')
    expect(html).toContain('Accept sponsor')
    expect(html).toContain('Decline offer')
  })
})

describe('SponsorPanelView — stale last-good state', () => {
  it('keeps the last good state visible with an honest refresh notice + Retry', () => {
    const html = renderView({ deployed: true, sponsor: SPONSOR, pending: null }, OWNER, true)
    expect(html).toContain('data-sponsor-panel="connected"')
    expect(html).toContain('data-testid="sponsor-stale"')
    expect(html).toContain('showing the last known status')
    expect(html).toContain('Retry')
  })
})

describe('SponsorPanel container — honesty on first paint', () => {
  it('a fresh mount renders the loading skeleton, never a status claim', () => {
    const html = renderToStaticMarkup(createElement(SponsorPanel, { merchantId: 7n }))
    expect(html).toContain('data-sponsor-panel="loading"')
    expect(html).not.toContain('Gas sponsor connected')
    expect(html).not.toContain('No gas sponsor wired')
    expect(html).not.toContain('isn&#x27;t deployed')
  })
})
