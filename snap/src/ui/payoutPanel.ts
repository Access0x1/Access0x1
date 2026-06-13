/**
 * Private-payout custom UI panel (WILL-TRY).
 *
 * Shown via a Snap dialog/interface when the dapp invokes the payout surface.
 * Displays the current payout balance and a "Withdraw Privately" button, and —
 * after a payout completes — the deposit/withdraw transactions as explorer links.
 *
 * Law #4 (truth in copy): the privacy line is the verbatim DEMO.md guardrail.
 * It never claims "anonymous" or "untraceable".
 */

import { Box, Button, Heading, Link, Row, Text } from '@metamask/snaps-sdk/jsx';
import type { JSXElement } from '@metamask/snaps-sdk/jsx';

import type { PayoutResult } from '../types';

/** The form field name the "Withdraw Privately" button reports on click. */
export const WITHDRAW_BUTTON_NAME = 'access0x1-withdraw-privately';

/**
 * The DEMO.md privacy guardrail line, shown verbatim. Never strengthen it.
 */
export const PRIVACY_COPY =
  "Your payout origin is confidential — competitors can't read your revenue on the public ledger.";

/**
 * Format a USD number as `$0.00`.
 *
 * @param balanceUsd - A USD amount as a number.
 * @returns A `$0.00` string.
 */
function formatBalance(balanceUsd: number): string {
  return `$${balanceUsd.toFixed(2)}`;
}

/**
 * Render the payout panel before a withdrawal: balance + the withdraw button.
 *
 * @param balanceUsd - The current payout balance in USD.
 * @returns A Snap JSX element.
 */
export function renderPayoutPanel(balanceUsd: number): JSXElement {
  return Box({
    children: [
      Heading({ children: 'Private Payout' }),
      Row({
        label: 'Available',
        children: Text({ children: formatBalance(balanceUsd) }),
      }),
      Text({ children: PRIVACY_COPY }),
      Button({
        name: WITHDRAW_BUTTON_NAME,
        variant: 'primary',
        children: 'Withdraw Privately',
      }),
    ],
  });
}

/**
 * Render the payout result panel: deposit + withdraw explorer links.
 *
 * @param result - The completed {@link PayoutResult}.
 * @returns A Snap JSX element.
 */
export function renderPayoutResultPanel(result: PayoutResult): JSXElement {
  return Box({
    children: [
      Heading({ children: 'Payout Complete' }),
      Text({ children: PRIVACY_COPY }),
      Row({
        label: 'Deposit',
        children: Link({
          href: result.arcscanDepositUrl,
          children: 'View on explorer',
        }),
      }),
      Row({
        label: 'Withdraw',
        children: Link({
          href: result.arcscanWithdrawUrl,
          children: 'View on explorer',
        }),
      }),
    ],
  });
}
