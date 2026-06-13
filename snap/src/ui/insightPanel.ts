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
import type { JSXElement } from '@metamask/snaps-sdk/jsx';

import { formatUsd } from '../router/decode';
import type { MerchantInfo, PaymentSummary } from '../types';

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
 * Render the payment insight panel for a decoded router call.
 *
 * @param summary - The decoded `PaymentSummary` from `parseRouterCall`.
 * @param merchant - The resolved merchant info from `fetchMerchantName`.
 * @returns A Snap JSX element to return as `{ content }` from `onTransaction`.
 */
export function renderInsightPanel(
  summary: PaymentSummary,
  merchant: MerchantInfo,
): JSXElement {
  const { fee, net } = computeFeeSplit(summary.usdAmount8, merchant.feeBps);

  return Box({
    children: [
      Heading({ children: 'Access0x1 Payment' }),
      Row({ label: 'Merchant', children: Text({ children: merchant.name }) }),
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
