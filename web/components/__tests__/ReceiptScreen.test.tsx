/**
 * @file ReceiptScreen.test.tsx — the receipt's "Return to merchant" href is
 * validated at the render boundary (red-report C-1).
 *
 * Runs in the vitest `node` environment via React's static server renderer (the
 * FundButton / TokenPicker precedent). Proves that an attacker-supplied
 * `returnUrl` prop — `javascript:`, `http:`, a `//evil` handoff — NEVER reaches
 * the rendered markup: the link is dropped entirely. A clean `https:` URL renders
 * a real "Return to merchant" anchor with `rel="noopener noreferrer"`.
 *
 * This is the in-component backstop test; `__tests__/safeUrl.test.ts` covers the
 * pure guard. Together they pin both the helper and its usage at the render point.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Hash } from 'viem'

import { ReceiptScreen } from '../ReceiptScreen'
import type { PaymentReceivedEvent } from '../../lib/contracts'

const RECEIPT: PaymentReceivedEvent = {
  merchantId: 1n,
  buyer: '0x1111111111111111111111111111111111111111',
  token: '0x2222222222222222222222222222222222222222',
  grossAmount: 1_000_000n,
  feeAmount: 0n,
  netAmount: 1_000_000n,
  usdAmount8: 100_000_000n,
  orderId: '0x00000000000000000000000000000000000000000000000000000000000000aa',
  srcChainSelector: 0n,
}

const TX_HASH = ('0x' + 'ab'.repeat(32)) as Hash

const render = (returnUrl?: string): string =>
  renderToStaticMarkup(
    createElement(ReceiptScreen, {
      receipt: RECEIPT,
      txHash: TX_HASH,
      chainId: 84532,
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      returnUrl,
    }),
  )

describe('ReceiptScreen — return link is guarded', () => {
  it('always shows the payment-confirmed body', () => {
    const out = render()
    expect(out).toContain('Payment confirmed')
  })

  it('renders NO link when no returnUrl is passed', () => {
    expect(render()).not.toContain('Return to merchant')
  })

  it('drops a javascript: returnUrl entirely (no XSS href)', () => {
    const out = render('javascript:alert(document.cookie)')
    expect(out).not.toContain('Return to merchant')
    expect(out).not.toContain('javascript:')
  })

  it('drops a plain http: returnUrl (no clear-text phishing handoff)', () => {
    const out = render('http://evil.example/phish')
    expect(out).not.toContain('Return to merchant')
    expect(out).not.toContain('evil.example')
  })

  it('drops a protocol-relative //evil returnUrl', () => {
    const out = render('//evil.example/phish')
    expect(out).not.toContain('Return to merchant')
    expect(out).not.toContain('evil.example')
  })

  it('renders a clean https: returnUrl as a safe anchor', () => {
    const out = render('https://merchant.example/thanks')
    expect(out).toContain('Return to merchant')
    expect(out).toContain('href="https://merchant.example/thanks"')
    // Hardened: external return link never leaks window.opener / referrer.
    expect(out).toContain('rel="noopener noreferrer"')
  })
})
