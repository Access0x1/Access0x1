/**
 * @file VerificationLadder.test.tsx — the pure LadderView renders each rung.
 *
 * Static-server render (no jsdom): proves the simple ladder surface shows the
 * three-rung chip row (○ → ✓ → ✓✓), the ONE next-step control for the current
 * rung, and the Super Verified state at the top — never a menu of providers.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { LadderView } from '../VerificationLadder'
import { nextLadderAction } from '@/lib/verification/ladder'
import type { LadderRung } from '@/lib/verification/ladder'
import type { VerificationMethod } from '@/lib/verification/tiers'

const html = (el: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(el)

const view = (rung: LadderRung, methods: VerificationMethod[], extra = {}) =>
  html(
    createElement(LadderView, {
      rung,
      action: nextLadderAction(methods),
      ...extra,
    }),
  )

describe('LadderView renders by rung', () => {
  it('always shows the three-rung chip row', () => {
    const out = view(0, [])
    expect(out).toContain('○ Connected')
    expect(out).toContain('✓ Verified')
    expect(out).toContain('✓✓ Super Verified')
    expect(out).toContain('aria-label="Verification ladder"')
  })

  it('○ Connected: offers exactly one next-step button, no provider menu', () => {
    const out = view(0, [])
    // The single World ID CTA (no recognized ENS name in this pure render).
    expect(out).toContain('Verify you’re a real person')
    // Exactly one <button> in the action area (the chip row uses <div> badges).
    const buttons = out.match(/<button/g) ?? []
    expect(buttons.length).toBe(1)
  })

  it('✓ Verified via World ID: the one button is the missing ENS proof', () => {
    const out = view(1, ['world-id'])
    expect(out).toContain('Verify your ENS name')
    const buttons = out.match(/<button/g) ?? []
    expect(buttons.length).toBe(1)
  })

  it('recognized ENS name → one-tap "Verify <name>" (no typed input)', () => {
    const out = html(
      createElement(LadderView, {
        rung: 0,
        action: nextLadderAction([], { hasRecognizedEnsName: true }),
        recognizedName: 'alice.eth',
        ensInputNeeded: false,
      }),
    )
    expect(out).toContain('Verify alice.eth')
    expect(out).not.toContain('yourname.eth') // no input placeholder shown
  })

  it('typed ENS path exposes an input with id + name (autofill-safe)', () => {
    const out = html(
      createElement(LadderView, {
        rung: 1,
        action: nextLadderAction(['world-id']),
        ensInputNeeded: true,
      }),
    )
    expect(out).toContain('id="ladder-ens-name"')
    expect(out).toContain('name="ens-name"')
  })

  it('✓✓ Super Verified: shows the badge, no action button', () => {
    const out = view(2, ['ens', 'world-id', 'dynamic'], { score: 100 })
    expect(out).toContain('Super Verified')
    const buttons = out.match(/<button/g) ?? []
    expect(buttons.length).toBe(0)
  })

  it('signed-out shows the greyed ladder + a connect prompt is the caller’s job', () => {
    // LadderView with connected chips still renders the row; the container gates
    // the signed-out copy. Here we assert the row is present at rung 0.
    const out = view(0, [])
    expect(out).toContain('data-rung="0"')
  })
})
