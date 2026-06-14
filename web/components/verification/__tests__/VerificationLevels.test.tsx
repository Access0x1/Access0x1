/**
 * @file VerificationLevels.test.tsx — the shadcn verification panel renders.
 *
 * Runs in the vitest `node` environment (no jsdom dep) via React's static server
 * renderer: it proves the component tree mounts and emits the expected text for
 * each rung — the level name, the trust score, the method chips, and the right
 * CTA / "Super Verified" line. Radix primitives are SSR-safe (the trigger renders;
 * the portal content mounts client-side), so this is a true render smoke test.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { VerificationLevels, LevelBadge } from '../VerificationLevels'
import { SuperVerifiedBadge } from '../SuperVerifiedBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { VerificationMethod } from '@/lib/verification/tiers'

const html = (el: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(el)

describe('shadcn ui primitives render', () => {
  it('Badge renders its variants (including the gold "super")', () => {
    expect(html(createElement(Badge, { variant: 'success' }, 'OK'))).toContain('OK')
    const sup = html(createElement(Badge, { variant: 'super' }, 'Super Verified'))
    expect(sup).toContain('Super Verified')
    expect(sup).toContain('ax1-shimmer') // the shimmer class is applied
  })

  it('Button renders, and asChild renders an anchor', () => {
    expect(html(createElement(Button, {}, 'Go'))).toContain('<button')
    const link = html(
      createElement(Button, { asChild: true }, createElement('a', { href: '/verify' }, 'Verify more')),
    )
    expect(link).toContain('<a')
    expect(link).toContain('href="/verify"')
  })

  it('Progress renders a progressbar with the value transform', () => {
    const out = html(createElement(Progress, { value: 40 }))
    expect(out).toContain('role="progressbar"')
    expect(out).toContain('translateX(-60%)')
  })
})

describe('VerificationLevels panel renders by rung', () => {
  const render = (methods: VerificationMethod[], score?: number): string =>
    html(createElement(VerificationLevels, { methods, score }))

  it('L0 Guest — shows the Guest level and a Verify more CTA', () => {
    const out = render([])
    expect(out).toContain('Guest')
    expect(out).toContain('0/100')
    expect(out).toContain('Verify more')
    expect(out).toContain('Your verification')
    // every method chip label appears
    expect(out).toContain('World ID')
    expect(out).toContain('ENS name')
  })

  it('L2 Verified — World ID alone shows Verified + 50/100', () => {
    const out = render(['world-id'])
    expect(out).toContain('Verified')
    expect(out).toContain('50/100')
  })

  it('L3 Trusted — World ID + ENS shows Trusted + 75/100', () => {
    const out = render(['world-id', 'ens'])
    expect(out).toContain('Trusted')
    expect(out).toContain('75/100')
  })

  it('L4 Super Verified — shows the celebratory line, no CTA', () => {
    const out = render(['world-id', 'ens', 'dynamic'])
    expect(out).toContain('Super Verified')
    expect(out).toContain('highest trust level')
    expect(out).not.toContain('Verify more')
  })
})

describe('LevelBadge + SuperVerifiedBadge render', () => {
  it('LevelBadge L4 uses the gold shimmer Badge', () => {
    const out = html(createElement(LevelBadge, { level: 4, name: 'Super Verified' }))
    expect(out).toContain('Super Verified')
    expect(out).toContain('ax1-shimmer')
  })

  it('LevelBadge L1 uses the neutral level Badge (no shimmer)', () => {
    const out = html(createElement(LevelBadge, { level: 1, name: 'Connected' }))
    expect(out).toContain('Connected')
    expect(out).not.toContain('ax1-shimmer')
  })

  it('SuperVerifiedBadge maps legacy tiers onto shadcn variants', () => {
    expect(html(createElement(SuperVerifiedBadge, { tier: 'super-verified', score: 100 }))).toContain(
      'ax1-shimmer',
    )
    const verified = html(createElement(SuperVerifiedBadge, { tier: 'verified', score: 50 }))
    expect(verified).toContain('Verified')
    expect(verified).not.toContain('ax1-shimmer')
    expect(html(createElement(SuperVerifiedBadge, { tier: 'standard' }))).toContain('Standard')
  })
})
