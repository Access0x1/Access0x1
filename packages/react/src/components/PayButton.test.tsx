/**
 * @file Unit tests for {@link PayButton}.
 *
 * Renders the real component over a live {@link usePayment}, driving status via a mock client.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PayButton } from './PayButton.js';
import { makeMockClient } from '../test/mockClient.js';
import { NATIVE_TOKEN, type Hex } from '../types.js';

const ROUTER: Hex = '0x2222222222222222222222222222222222222222';
const TX_HASH: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000001';

describe('PayButton', () => {
  it('renders the default label, and a custom label when provided', () => {
    const client = makeMockClient({ reads: { quote: () => 1n } });

    const { rerender } = render(
      <PayButton merchantId={1n} usdAmount={29} routerAddress={ROUTER} client={client} />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Pay with Crypto');

    rerender(
      <PayButton
        merchantId={1n}
        usdAmount={29}
        routerAddress={ROUTER}
        client={client}
        label="Pay with USDC"
      />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Pay with USDC');
  });

  it('disables the button and shows a spinner while pending', async () => {
    // quote resolves, but the payNative write hangs → status stays in confirm/pending
    let resolveWrite!: (h: Hex) => void;
    const client = makeMockClient({
      reads: { quote: () => 5n },
      writes: {
        payNative: () =>
          new Promise<Hex>((res) => {
            resolveWrite = res;
          }),
      },
    });

    render(<PayButton merchantId={1n} usdAmount={29} routerAddress={ROUTER} client={client} />);

    await act(async () => {
      screen.getByRole('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled());
    expect(screen.getByTestId('access0x1-spinner')).toBeInTheDocument();

    // tidy up the hanging promise (the event never fires, so the flow parks in pending — fine)
    await act(async () => {
      resolveWrite(TX_HASH);
      await Promise.resolve();
    });
  });

  it('surfaces a typed error message inline on failure', async () => {
    const client = makeMockClient({
      reads: {
        quote: () => {
          const e = new Error('reverted');
          (e as unknown as { data: { errorName: string } }).data = {
            errorName: 'Access0x1__MerchantInactive',
          };
          throw e;
        },
      },
    });

    render(
      <PayButton
        merchantId={1n}
        usdAmount={29}
        token={NATIVE_TOKEN}
        routerAddress={ROUTER}
        client={client}
      />,
    );

    await act(async () => {
      screen.getByRole('button').click();
      await Promise.resolve();
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-access0x1-error', 'MERCHANT_INACTIVE');
    expect(alert).toHaveTextContent('not currently accepting payments');
  });
});
