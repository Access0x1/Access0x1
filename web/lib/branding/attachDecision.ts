/**
 * attachDecision.ts — the pure success/failure decision for "switch on payments".
 *
 * The dashboard's `handleRegistered` (and its retry button) call the
 * `attachOnChain` client helper, which returns a discriminated result:
 *   { ok: true; branding } | { ok: false; error; code? }.
 *
 * The UI MUST NOT flip to "✓ Payments are on" until the bind actually succeeds —
 * otherwise the merchant sees "live" while the customer page still reads
 * "hasn't switched on payments yet" (law #4: truth in copy; law #5: money paths
 * never claim success they didn't deliver). This pure function encodes that one
 * decision so the component and its test share the exact branch, with no React
 * render needed to verify it.
 */

/** The discriminated shape returned by the `attachOnChain` client helper. */
export type AttachResult =
  | { ok: true; branding: unknown }
  | { ok: false; error: string; code?: string }

/** What the dashboard should do after an attach attempt. */
export type AttachDecision =
  | { kind: 'confirm' }
  | { kind: 'show-error'; error: string; code?: string }

/**
 * Decide whether the "switch on payments" card may flip to the live confirmation.
 *
 * @param result - the `attachOnChain` discriminated result.
 * @returns `{kind:'confirm'}` ONLY when the bind succeeded; otherwise
 *   `{kind:'show-error'}` carrying the plain-English message (and code) to render
 *   inside the Switch-on-payments card alongside a retry.
 */
export function decideAttach(result: AttachResult): AttachDecision {
  if (result.ok) return { kind: 'confirm' }
  return { kind: 'show-error', error: result.error, code: result.code }
}

/**
 * May the UI claim payments are on? True ONLY for a successful bind — never on a
 * failed attach (the honesty guard the merchant-vs-customer mismatch hinges on).
 */
export function canShowPaymentsOn(result: AttachResult): boolean {
  return result.ok === true
}
