/**
 * @file attachDecision.test.ts — the "switch on payments" flip decision.
 *
 * The dashboard must only flip to "✓ Payments are on" when the server BIND
 * (attachOnChain) actually succeeds — otherwise the merchant sees "live" while
 * the customer page still reads "hasn't switched on payments yet" (law #4: truth
 * in copy; law #5: money paths never claim success they didn't deliver). The
 * dashboard component shares THIS pure decision, so pinning it here pins the
 * component's honesty guard without a DOM render (the test env is node-only,
 * `renderToStaticMarkup`, which cannot drive post-callback async state).
 */
import { describe, expect, it } from 'vitest'
import { canShowPaymentsOn, decideAttach } from '../attachDecision'

describe('decideAttach', () => {
  it('confirms ONLY on a successful bind', () => {
    expect(decideAttach({ ok: true, branding: {} })).toEqual({ kind: 'confirm' })
  })

  it('shows the error (never confirms) on a failed bind', () => {
    const decision = decideAttach({
      ok: false,
      error: 'Could not switch on payments. Please try again.',
      code: 'attach_failed',
    })
    expect(decision).toEqual({
      kind: 'show-error',
      error: 'Could not switch on payments. Please try again.',
      code: 'attach_failed',
    })
  })

  it('carries the casino code through so the UI can branch on it', () => {
    const decision = decideAttach({
      ok: false,
      error: 'Casinos must verify with World ID before going live.',
      code: 'CASINO_NEEDS_OPERATOR',
    })
    expect(decision.kind).toBe('show-error')
    if (decision.kind === 'show-error') expect(decision.code).toBe('CASINO_NEEDS_OPERATOR')
  })
})

describe('canShowPaymentsOn', () => {
  it('is true ONLY for a successful bind', () => {
    expect(canShowPaymentsOn({ ok: true, branding: {} })).toBe(true)
  })

  it('is false for every failure variant', () => {
    expect(canShowPaymentsOn({ ok: false, error: 'x' })).toBe(false)
    expect(canShowPaymentsOn({ ok: false, error: 'x', code: 'no_branding' })).toBe(false)
    expect(canShowPaymentsOn({ ok: false, error: 'x', code: 'CASINO_NEEDS_OPERATOR' })).toBe(false)
  })
})
