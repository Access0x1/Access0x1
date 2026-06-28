/**
 * @file Unit tests for {@link PayButton}.
 *
 * Two layers of coverage:
 *   1. The pure derivation helpers exposed via `__internals` (disabled-reason derivation, quote-error
 *      mapping, explorer-URL building) — asserted directly, no render.
 *   2. The component itself, rendered over a live {@link usePayment} and driven via a mock client:
 *      disabled/success/error rendering, the callback surface (onQuote/onSettled), and the
 *      busy/disabled button state transitions.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PayButton, __internals, type PayButtonProps } from './PayButton.js';
import { makeMockClient, revertError, type MockClient } from '../test/mockClient.js';
import { Access0x1Error } from '../errors.js';
import { NATIVE_TOKEN, type Hex, type PaymentReceipt } from '../types.js';

const { deriveConfigDisabledReason, quoteErrorToDisabledReason, buildExplorerUrl, DISABLED_LABELS } =
  __internals;

const ROUTER: Hex = '0x2222222222222222222222222222222222222222';
const TX_HASH: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000001';
const EXPLORER = 'https://testnet.arcscan.app';
// A token address with mixed checksum casing, to prove case-insensitive allowlist matching.
const USDC_CHECKSUM: Hex = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_LOWER: Hex = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const OTHER_TOKEN: Hex = '0x9999999999999999999999999999999999999999';

const GROSS_NATIVE = 5n * 10n ** 15n;

/** A registered-watcher `PaymentReceived` log that resolves the hook's receipt promise. */
function paymentReceivedLog(client: MockClient, overrides: Record<string, unknown> = {}) {
  client.emitEvent({
    eventName: 'PaymentReceived',
    transactionHash: TX_HASH,
    blockNumber: 100n,
    args: {
      merchantId: 1n,
      buyer: client.account,
      token: NATIVE_TOKEN,
      grossAmount: GROSS_NATIVE,
      feeAmount: 145000000000000n,
      netAmount: GROSS_NATIVE - 145000000000000n,
      usdAmount8: 2_900_000_000n,
      orderId: '0x'.padEnd(66, '0') as Hex,
      srcChainSelector: 0n,
      ...overrides,
    },
  });
}

/** Render, click pay, and fire the success event so the flow reaches `success`. Returns the client. */
async function renderAndSettle(props: Partial<PayButtonProps> = {}) {
  const client = makeMockClient({
    reads: { quote: () => GROSS_NATIVE },
    writes: { payNative: () => TX_HASH },
  });

  render(
    <PayButton merchantId={1n} usdAmount={29} routerAddress={ROUTER} client={client} {...props} />,
  );

  await act(async () => {
    screen.getByRole('button').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    paymentReceivedLog(client);
    await Promise.resolve();
  });

  return client;
}

// ---------------------------------------------------------------------------
// 1. deriveConfigDisabledReason()
// ---------------------------------------------------------------------------
describe('deriveConfigDisabledReason()', () => {
  const client = makeMockClient();

  it('returns "no-client" when no client is supplied', () => {
    expect(deriveConfigDisabledReason(undefined, undefined, undefined, true)).toBe('no-client');
  });

  it('returns "no-feed" when priceFeedConfigured is false', () => {
    expect(deriveConfigDisabledReason(client, undefined, undefined, false)).toBe('no-feed');
  });

  it('returns null (enabled) when the token is present in allowedTokens', () => {
    expect(deriveConfigDisabledReason(client, USDC_CHECKSUM, [USDC_CHECKSUM], true)).toBeNull();
  });

  it('returns "token-not-allowed" when the token is absent from allowedTokens', () => {
    expect(deriveConfigDisabledReason(client, OTHER_TOKEN, [USDC_CHECKSUM], true)).toBe(
      'token-not-allowed',
    );
  });

  it('matches case-insensitively (checksummed token vs lowercase allowlist entry)', () => {
    expect(deriveConfigDisabledReason(client, USDC_CHECKSUM, [USDC_LOWER], true)).toBeNull();
    expect(deriveConfigDisabledReason(client, USDC_LOWER, [USDC_CHECKSUM], true)).toBeNull();
  });

  it('treats an undefined token as NATIVE_TOKEN for the allowlist check', () => {
    // undefined token → native sentinel; allowlist contains native → enabled.
    expect(deriveConfigDisabledReason(client, undefined, [NATIVE_TOKEN], true)).toBeNull();
    // explicit NATIVE_TOKEN behaves the same.
    expect(deriveConfigDisabledReason(client, NATIVE_TOKEN, [NATIVE_TOKEN], true)).toBeNull();
    // undefined token, native NOT in the allowlist → disabled.
    expect(deriveConfigDisabledReason(client, undefined, [USDC_CHECKSUM], true)).toBe(
      'token-not-allowed',
    );
  });

  it('skips the allowlist check entirely when allowedTokens is undefined', () => {
    expect(deriveConfigDisabledReason(client, OTHER_TOKEN, undefined, true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. quoteErrorToDisabledReason()
// ---------------------------------------------------------------------------
describe('quoteErrorToDisabledReason()', () => {
  it('maps TOKEN_NOT_ALLOWED → "token-not-allowed"', () => {
    expect(quoteErrorToDisabledReason(new Access0x1Error('TOKEN_NOT_ALLOWED', 'x'))).toBe(
      'token-not-allowed',
    );
  });

  it('maps STALE_PRICE → "quote-unavailable"', () => {
    expect(quoteErrorToDisabledReason(new Access0x1Error('STALE_PRICE', 'x'))).toBe(
      'quote-unavailable',
    );
  });

  it('maps INVALID_PRICE → "quote-unavailable"', () => {
    expect(quoteErrorToDisabledReason(new Access0x1Error('INVALID_PRICE', 'x'))).toBe(
      'quote-unavailable',
    );
  });

  it('does NOT disable for non-feed errors (UNDERPAID, MERCHANT_INACTIVE)', () => {
    expect(quoteErrorToDisabledReason(new Access0x1Error('UNDERPAID', 'x'))).toBeNull();
    expect(quoteErrorToDisabledReason(new Access0x1Error('MERCHANT_INACTIVE', 'x'))).toBeNull();
  });

  it('returns null for a null error', () => {
    expect(quoteErrorToDisabledReason(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. buildExplorerUrl()
// ---------------------------------------------------------------------------
describe('buildExplorerUrl()', () => {
  it('strips a trailing slash from the base URL', () => {
    expect(buildExplorerUrl('https://explorer.example/', TX_HASH)).toBe(
      `https://explorer.example/tx/${TX_HASH}`,
    );
  });

  it('strips multiple trailing slashes', () => {
    expect(buildExplorerUrl('https://explorer.example///', TX_HASH)).toBe(
      `https://explorer.example/tx/${TX_HASH}`,
    );
  });

  it('works with a base URL that has no trailing slash', () => {
    expect(buildExplorerUrl('https://explorer.example', TX_HASH)).toBe(
      `https://explorer.example/tx/${TX_HASH}`,
    );
  });

  it('returns null when the base is null', () => {
    expect(buildExplorerUrl(null as unknown as undefined, TX_HASH)).toBeNull();
  });

  it('returns null when the base is undefined', () => {
    expect(buildExplorerUrl(undefined, TX_HASH)).toBeNull();
  });

  it('returns null for an empty-string base', () => {
    expect(buildExplorerUrl('', TX_HASH)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Idle / label rendering + disabled-button rendering
// ---------------------------------------------------------------------------
describe('PayButton — labels', () => {
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
});

describe('PayButton — disabled rendering', () => {
  it('renders a disabled button when disabledReason != null (no client)', () => {
    render(<PayButton merchantId={1n} usdAmount={29} routerAddress={ROUTER} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('data-access0x1-disabled-reason', 'no-client');
  });

  it('sets data-access0x1-status="disabled" and the reason for token-not-allowed', () => {
    const client = makeMockClient();
    render(
      <PayButton
        merchantId={1n}
        usdAmount={29}
        token={OTHER_TOKEN}
        routerAddress={ROUTER}
        client={client}
        allowedTokens={[USDC_CHECKSUM]}
      />,
    );
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('data-access0x1-status', 'disabled');
    expect(btn).toHaveAttribute('data-access0x1-disabled-reason', 'token-not-allowed');
  });

  it('shows the default reason-specific label from DISABLED_LABELS', () => {
    render(<PayButton merchantId={1n} usdAmount={29} routerAddress={ROUTER} />);
    expect(screen.getByRole('button')).toHaveTextContent(DISABLED_LABELS['no-client']);
  });

  it('a custom disabledLabel overrides the default', () => {
    render(
      <PayButton
        merchantId={1n}
        usdAmount={29}
        routerAddress={ROUTER}
        disabledLabel="Custom disabled copy"
      />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Custom disabled copy');
  });

  it('a renderDisabled callback fully overrides the disabled node', () => {
    const renderDisabled = vi.fn((reason: string) => (
      <div data-testid="custom-disabled">disabled: {reason}</div>
    ));
    render(
      <PayButton
        merchantId={1n}
        usdAmount={29}
        routerAddress={ROUTER}
        renderDisabled={renderDisabled}
      />,
    );
    expect(screen.getByTestId('custom-disabled')).toHaveTextContent('disabled: no-client');
    // No fallback <button> is rendered when the host owns the node.
    expect(screen.queryByRole('button')).toBeNull();
    expect(renderDisabled).toHaveBeenCalledWith('no-client');
  });
});

// ---------------------------------------------------------------------------
// 5. Success-state rendering
// ---------------------------------------------------------------------------
describe('PayButton — success rendering', () => {
  it('renders the success node once status === "success"', async () => {
    await renderAndSettle();
    await waitFor(() => {
      const root = document.querySelector('[data-access0x1-status="success"]');
      expect(root).not.toBeNull();
      expect(root).toHaveTextContent('Paid — view receipt');
    });
  });

  it('renders an explorer link when explorerBaseUrl is provided', async () => {
    await renderAndSettle({ explorerBaseUrl: EXPLORER });
    await waitFor(() => {
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', `${EXPLORER}/tx/${TX_HASH}`);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  it('renders plain text (no link) when explorerBaseUrl is not provided', async () => {
    await renderAndSettle();
    await waitFor(() => {
      expect(document.querySelector('[data-access0x1-status="success"]')).not.toBeNull();
    });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a renderSuccess callback overrides the success node', async () => {
    const renderSuccess = vi.fn((r: PaymentReceipt) => (
      <div data-testid="custom-success">paid {r.txHash}</div>
    ));
    await renderAndSettle({ explorerBaseUrl: EXPLORER, renderSuccess });
    await waitFor(() => {
      expect(screen.getByTestId('custom-success')).toHaveTextContent(`paid ${TX_HASH}`);
    });
    // The default link is suppressed when the host owns the node.
    expect(screen.queryByRole('link')).toBeNull();
    expect(renderSuccess).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Callback firing — onQuote / onSettled
// ---------------------------------------------------------------------------
describe('PayButton — callbacks', () => {
  it('fires onQuote with the full QuoteResult shape on a successful quote', async () => {
    const onQuote = vi.fn();
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: { payNative: () => TX_HASH },
    });

    render(
      <PayButton
        merchantId={7n}
        usdAmount={29}
        routerAddress={ROUTER}
        client={client}
        onQuote={onQuote}
      />,
    );

    await act(async () => {
      screen.getByRole('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(onQuote).toHaveBeenCalled());
    expect(onQuote).toHaveBeenCalledWith({
      merchantId: 7n,
      token: NATIVE_TOKEN,
      usdAmount8: 2_900_000_000n,
      grossAmount: GROSS_NATIVE,
      error: null,
    });
  });

  it('fires onQuote on a failed quote, carrying the typed error and a null grossAmount', async () => {
    const onQuote = vi.fn();
    const client = makeMockClient({
      reads: {
        quote: () => {
          throw revertError('OracleLib__StalePrice');
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
        onQuote={onQuote}
      />,
    );

    await act(async () => {
      screen.getByRole('button').click();
      await Promise.resolve();
    });

    await waitFor(() => expect(onQuote).toHaveBeenCalled());
    const arg = onQuote.mock.calls.at(-1)?.[0];
    expect(arg.grossAmount).toBeNull();
    expect(arg.error).toBeInstanceOf(Access0x1Error);
    expect(arg.error.code).toBe('STALE_PRICE');
  });

  it('fires onQuote again on a second, distinct quote attempt (multiple times)', async () => {
    const onQuote = vi.fn();
    let attempt = 0;
    const client = makeMockClient({
      reads: {
        // Each attempt quotes a DIFFERENT gross, so the `[quote, quoteError]`-keyed effect re-fires.
        quote: () => {
          attempt += 1;
          return GROSS_NATIVE + BigInt(attempt);
        },
      },
      writes: {
        // A non-disabling pay error (UNDERPAID) leaves the button enabled to re-quote.
        payNative: () => {
          throw revertError('Access0x1__Underpaid');
        },
      },
    });

    render(
      <PayButton
        merchantId={1n}
        usdAmount={29}
        routerAddress={ROUTER}
        client={client}
        onQuote={onQuote}
      />,
    );

    await act(async () => {
      screen.getByRole('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(onQuote).toHaveBeenCalledTimes(1));
    expect(onQuote.mock.calls[0]?.[0].grossAmount).toBe(GROSS_NATIVE + 1n);

    // The UNDERPAID error is non-disabling, so the button is enabled again; click to re-quote.
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    await act(async () => {
      screen.getByRole('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(onQuote).toHaveBeenCalledTimes(2));
    expect(onQuote.mock.calls[1]?.[0].grossAmount).toBe(GROSS_NATIVE + 2n);
  });

  it('fires onSettled with the receipt and a correctly-formed explorer URL', async () => {
    const onSettled = vi.fn();
    await renderAndSettle({ explorerBaseUrl: `${EXPLORER}/`, onSettled });

    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    const arg = onSettled.mock.calls.at(-1)?.[0];
    expect(arg.receipt.txHash).toBe(TX_HASH);
    // Trailing slash on the base must be normalized to a single `/tx/`.
    expect(arg.explorerUrl).toBe(`${EXPLORER}/tx/${TX_HASH}`);
  });

  it('fires onSettled with explorerUrl null when no explorerBaseUrl was provided', async () => {
    const onSettled = vi.fn();
    await renderAndSettle({ onSettled });

    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(onSettled.mock.calls.at(-1)?.[0].explorerUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Button state transitions (busy / disabled while in-flight)
// ---------------------------------------------------------------------------
describe('PayButton — busy state', () => {
  it('disables the button and shows a spinner while the tx is pending', async () => {
    // quote resolves, but the payNative write hangs → status parks in confirm/pending
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
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-busy', 'true');
    // confirm/pending status is reflected on the element.
    expect(btn.getAttribute('data-access0x1-status')).toMatch(/confirm|pending/);
    expect(screen.getByTestId('access0x1-spinner')).toBeInTheDocument();

    await act(async () => {
      resolveWrite(TX_HASH);
      await Promise.resolve();
    });
  });

  it('disables the button during the quoting status', async () => {
    // Hang the quote read so the flow parks in `quoting`.
    let resolveQuote!: (g: bigint) => void;
    const client = makeMockClient({
      reads: {
        quote: () =>
          new Promise<bigint>((res) => {
            resolveQuote = res;
          }),
      },
      writes: { payNative: () => TX_HASH },
    });

    render(<PayButton merchantId={1n} usdAmount={29} routerAddress={ROUTER} client={client} />);

    await act(async () => {
      screen.getByRole('button').click();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled());
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('data-access0x1-status', 'quoting');
    expect(btn).toHaveTextContent('Getting price…');

    await act(async () => {
      resolveQuote(5n);
      await Promise.resolve();
    });
  });

  it('is enabled in the idle state', () => {
    const client = makeMockClient({ reads: { quote: () => 1n } });
    render(<PayButton merchantId={1n} usdAmount={29} routerAddress={ROUTER} client={client} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeEnabled();
    expect(btn).toHaveAttribute('data-access0x1-status', 'idle');
    expect(btn).toHaveAttribute('aria-busy', 'false');
  });

  it('returns to an enabled button after a (non-disabling) error', async () => {
    const client = makeMockClient({
      reads: { quote: () => GROSS_NATIVE },
      writes: {
        payNative: () => {
          throw revertError('Access0x1__Underpaid');
        },
      },
    });
    render(<PayButton merchantId={1n} usdAmount={29} routerAddress={ROUTER} client={client} />);

    await act(async () => {
      screen.getByRole('button').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    expect(screen.getByRole('button')).toHaveAttribute('data-access0x1-status', 'error');
  });
});

// ---------------------------------------------------------------------------
// 8. Error display
// ---------------------------------------------------------------------------
describe('PayButton — error display', () => {
  it('surfaces a typed error message inline with role="alert" and the error code', async () => {
    const client = makeMockClient({
      reads: {
        quote: () => {
          throw revertError('Access0x1__MerchantInactive');
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

  it('does not render an alert when there is no error', () => {
    const client = makeMockClient({ reads: { quote: () => 1n } });
    render(<PayButton merchantId={1n} usdAmount={29} routerAddress={ROUTER} client={client} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
