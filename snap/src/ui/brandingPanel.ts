/**
 * The white-label merchant branding header — the "moment of truth" UI (ADR D4c).
 *
 * Rendered ABOVE the payment insight inside the MetaMask confirmation screen so
 * the paying customer sees the merchant's own logo, "Pay {Business Name}", and a
 * one-line description right where the wallet asks them to sign.
 *
 * Branding is DISPLAY-ONLY (doctrine #1): this header never gates, signs, or
 * blocks a payment or refund. If a merchant has no logo, we simply omit the
 * `Image` — the surface still renders cleanly. We use `info`/`success` `Banner`s
 * only (never the Flask-only `critical` modal, ADR D5).
 *
 * Law #4 (truth in copy): the "Verified on-chain" banner appears ONLY when the
 * caller resolved `verified === true` (i.e. `keccak256(name) === nameHash`); we
 * never imply a chain guarantee we don't have.
 */

import {
  Banner,
  Box,
  Divider,
  Heading,
  Image,
  Row,
  Text,
} from '@metamask/snaps-sdk/jsx';
import type { GenericSnapElement, JSXElement } from '@metamask/snaps-sdk/jsx';

import type { MerchantBranding } from '../types';

/** Verbatim copy for the on-chain verification banner (truthful, never stronger). */
export const VERIFIED_COPY =
  'This business name matches its on-chain registration.';

/**
 * Build the children of the branded header from resolved branding. Returned as a
 * flat array so {@link renderBrandingHeader} (and the composed insight panel) can
 * spread it. Conditional pieces (logo, description, verified banner) are simply
 * omitted when absent.
 *
 * @param branding - The resolved, already-sanitized branding.
 * @returns The header's child elements, in render order.
 */
export function brandingHeaderChildren(
  branding: MerchantBranding,
): GenericSnapElement[] {
  const children: GenericSnapElement[] = [];

  // Logo — inline SVG only (ADR D5). Omitted entirely when there is none.
  if (branding.logoSvg) {
    children.push(
      Image({ src: branding.logoSvg, alt: `${branding.name} logo` }),
    );
  }

  // "Pay {Business Name}" — the headline the customer reads.
  children.push(Heading({ children: `Pay ${branding.name}` }));

  // One-line description, when present.
  if (branding.description.length > 0) {
    children.push(Text({ children: branding.description }));
  }

  // Truthful on-chain verification badge — only when the hash actually matched.
  if (branding.verified) {
    children.push(
      Banner({
        title: 'Verified on-chain',
        severity: 'success',
        children: Text({ children: VERIFIED_COPY }),
      }),
    );
  }

  return children;
}

/**
 * Render the branded header as a standalone `Box` (used by the pre-sign dialog).
 *
 * @param branding - The resolved branding.
 * @returns A Snap JSX element.
 */
export function renderBrandingHeader(branding: MerchantBranding): JSXElement {
  return Box({ children: brandingHeaderChildren(branding) });
}

/**
 * Render the optional pre-sign confirmation body (ADR D4 path 1): the branded
 * header plus an "Amount" row, for a `snap_dialog` of type `confirmation`. The
 * confirmation type supplies its own Accept/Reject buttons.
 *
 * This is DISPLAY + CONSENT only: the dApp sends the actual pay tx (the Snap
 * cannot call `eth_sendTransaction`, ADR D5). Rejecting here is a UX courtesy,
 * never the enforcement point for a money path.
 *
 * @param branding - The resolved branding.
 * @param amountLabel - A pre-formatted amount string (e.g. `"$29.00"` or `"12.50 USDC"`).
 * @returns A Snap JSX element for `snap_dialog`'s `content`.
 */
export function renderBrandedConfirmation(
  branding: MerchantBranding,
  amountLabel: string,
): JSXElement {
  return Box({
    children: [
      ...brandingHeaderChildren(branding),
      Divider({}),
      Row({ label: 'Amount', children: Text({ children: amountLabel }) }),
    ],
  });
}
