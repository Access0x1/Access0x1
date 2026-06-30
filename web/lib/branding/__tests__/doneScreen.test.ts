/**
 * @file doneScreen.test.ts — the onboard reconnect "restore DONE screen" gate.
 *
 * A returning merchant who already saved branding should land on the DONE screen
 * (checkout link + embed + "Test it" + "Switch on payments") on reconnect, not a
 * blank-looking edit form. A brand-new tenant (no row) should NOT restore.
 */
import { describe, expect, it } from 'vitest'
import { shouldRestoreSavedOnReconnect } from '../doneScreen'

describe('shouldRestoreSavedOnReconnect', () => {
  it('restores when a saved row with a checkout slug exists', () => {
    expect(shouldRestoreSavedOnReconnect({ checkoutSlug: 'acme' })).toBe(true)
  })

  it('does NOT restore for a brand-new tenant (no row)', () => {
    expect(shouldRestoreSavedOnReconnect(null)).toBe(false)
  })

  it('does NOT restore when the row has no usable slug', () => {
    expect(shouldRestoreSavedOnReconnect({})).toBe(false)
    expect(shouldRestoreSavedOnReconnect({ checkoutSlug: '' })).toBe(false)
  })
})
