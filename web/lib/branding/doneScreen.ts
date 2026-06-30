/**
 * doneScreen.ts — when a returning merchant's onboard view restores the DONE
 * screen on reconnect.
 *
 * The "Make it yours" form (BrandingForm) has two screens in `mode="onboard"`:
 * the edit form, and the DONE screen (checkout link + embed + "Test it" + the
 * "Switch on payments" CTA). On first save we flip to DONE. On RECONNECT — a
 * returning merchant who already has a saved branding row — we also restore DONE
 * so they land on their link/embed/"Test it" screen (with the Edit affordance)
 * rather than a blank-looking "Save and get my checkout link" form.
 *
 * Settings mode is unaffected: it has its own compact "Changes saved" affordance
 * and never shows the DONE screen — but it DOES prefill `saved` for that
 * affordance, so the predicate below answers "true whenever a row exists",
 * independent of mode (BrandingForm gates the DONE *screen* on mode === onboard).
 */

/**
 * Should the prefill restore the saved state (which, in onboard mode, surfaces
 * the DONE screen) for a returning merchant?
 *
 * @param row - the loaded branding row, or null when the tenant has none yet.
 * @returns true when a saved row exists (restore); false for a brand-new tenant.
 */
export function shouldRestoreSavedOnReconnect(row: { checkoutSlug?: string } | null): boolean {
  return Boolean(row && row.checkoutSlug)
}
