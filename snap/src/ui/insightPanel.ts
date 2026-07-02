/**
 * The readable payment insight panel — the PRIMARY Snap surface.
 *
 * Renders inside the MetaMask confirmation screen when the user is about to
 * sign a router `payNative` / `payToken` call. Built with the `@metamask/snaps-sdk`
 * JSX components called as plain functions (no JSX transform needed), so the
 * panel structure is fully type-checked and unit-testable.
 *
 * Law #4 (truth in copy): this panel never says "anonymous" or "untraceable";
 * it states exactly what is on-chain — amount, token, fee split, merchant, chain.
 */

import {
  Box,
  Divider,
  Heading,
  Row,
  Text,
} from '@metamask/snaps-sdk/jsx';
import type { GenericSnapElement, JSXElement } from '@metamask/snaps-sdk/jsx';

import { brandingHeaderChildren } from './brandingPanel';
import { formatUsd } from '../router/decode';
import type {
  MerchantBranding,
  MerchantInfo,
  PaymentSummary,
} from '../types';

/** Basis-point denominator (10_000 = 100%). */
const FEE_DENOMINATOR = 10000n;

/**
 * Truncate an address to `0x1234…cdef` for compact display.
 *
 * @param address - A 20-byte hex address.
 * @returns The truncated form.
 */
export function truncateAddress(address: `0x${string}`): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The label for the token being paid: `"Native"` for a native-coin payment,
 * otherwise the truncated ERC-20 address.
 *
 * @param token - The token address, or `null` for native.
 * @returns A display string for the token.
 */
export function tokenLabel(token: `0x${string}` | null): string {
  return token === null ? 'Native' : truncateAddress(token);
}

/**
 * Compute the fee split from a USD amount and the merchant's combined fee bps.
 *
 * Display-only: the precise on-chain split is computed in-contract against the
 * live price feed. This mirrors it for the panel using `usdAmount8` so the
 * numbers shown are in the merchant's exact USD units.
 *
 * @param usdAmount8 - Gross price scaled by 1e8.
 * @param feeBps - The merchant surcharge in bps (combined fee shown to the user).
 * @returns The fee and net amounts, both 8-decimal USD.
 */
export function computeFeeSplit(
  usdAmount8: bigint,
  feeBps: number,
): { fee: bigint; net: bigint } {
  const fee = (usdAmount8 * BigInt(feeBps)) / FEE_DENOMINATOR;
  return { fee, net: usdAmount8 - fee };
}

/**
 * The merchant label shown in the "Merchant" row. Prefers the white-label
 * branding name when present (so the row matches the branded header); otherwise
 * falls back to the on-chain-resolved `MerchantInfo.name` ("Merchant #<id>").
 *
 * @param merchant - The on-chain-resolved merchant info.
 * @param branding - Optional resolved white-label branding.
 * @returns The display label for the Merchant row.
 */
function merchantRowLabel(
  merchant: MerchantInfo,
  branding?: MerchantBranding,
): string {
  return branding?.name ?? merchant.name;
}

/**
 * Render the payment insight panel for a decoded router call.
 *
 * When white-label `branding` is supplied (resolved by the D4 ladder), the
 * branded header — logo + "Pay {name}" + description + (when verified) an
 * on-chain badge — is rendered ABOVE the payment insight. Branding is
 * display-only and is purely additive: with no branding this renders exactly the
 * pre-existing panel, so it can never regress the insight surface.
 *
 * @param summary - The decoded `PaymentSummary` from `parseRouterCall`.
 * @param merchant - The resolved merchant info from `fetchMerchantName`.
 * @param branding - Optional resolved white-label branding (ADR unit 7).
 * @returns A Snap JSX element to return as `{ content }` from `onTransaction`.
 */
export function renderInsightPanel(
  summary: PaymentSummary,
  merchant: MerchantInfo,
  branding?: MerchantBranding,
): JSXElement {
  // The on-chain fee is platformFeeBps + the merchant surcharge (see _splitFee).
  // Showing only merchant.feeBps understated the fee and overstated the net — a
  // truthfulness failure on the signing screen. The contract caps the sum at
  // MAX_FEE_BPS at registration, so no re-cap is needed here.
  const { fee, net } = computeFeeSplit(
    summary.usdAmount8,
    merchant.platformFeeBps + merchant.feeBps,
  );

  // White-label header (logo + "Pay {name}" + description + verified badge),
  // followed by a divider, ABOVE the payment insight. Omitted with no branding.
  const header: GenericSnapElement[] = branding
    ? [...brandingHeaderChildren(branding), Divider({})]
    : [Heading({ children: 'Access0x1 Payment' })];

  return Box({
    children: [
      ...header,
      Row({
        label: 'Merchant',
        children: Text({ children: merchantRowLabel(merchant, branding) }),
      }),
      Row({
        label: 'Amount',
        children: Text({ children: formatUsd(summary.usdAmount8) }),
      }),
      Row({
        label: 'Token',
        children: Text({ children: tokenLabel(summary.token) }),
      }),
      Divider({}),
      Row({
        label: 'Platform + merchant fee',
        children: Text({ children: formatUsd(fee) }),
      }),
      Row({
        label: 'Merchant receives',
        children: Text({ children: formatUsd(net) }),
      }),
      Divider({}),
      Row({
        label: 'Order',
        children: Text({ children: summary.orderIdLabel }),
      }),
      Row({
        label: 'Chain',
        children: Text({ children: summary.chainLabel }),
      }),
    ],
  });
}
