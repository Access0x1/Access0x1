/**
 * @file `<PayButton>` — the drop-in payment button.
 *
 * A thin UI shell over {@link usePayment}. It is a single `<button>` with no modal/overlay by
 * default — the host app keeps full layout control via `className`. It shows a spinner while the tx
 * is in `confirm`/`pending`, an inline confirmation on success, and the typed error message on
 * failure.
 *
 * **Graceful degradation (the drop-in promise must never produce a dead-end click).** When the
 * router has no feed or no allowlist entry for the chosen token, paying would revert. Rather than let
 * the buyer click into a guaranteed failure, `<PayButton>` renders a *disabled* button with truthful,
 * specific copy. The disabled state is derived from two signals: host-declared config
 * (`allowedTokens`, `priceFeedConfigured`, the presence of a `client`) and the live probe `quote()`
 * result surfaced by {@link usePayment} (`quoteError`). See {@link PayButtonDisabledReason}.
 *
 * **Callbacks.** The component re-emits the hook's lifecycle as a fully-typed callback surface:
 * `onQuote` (every quote attempt, success or failure), `onSettled` (receipt + explorer URL on
 * settlement), `onSuccess` (the receipt, kept for back-compat), and `onError` (the typed error). All
 * payloads are defined once in `../types.js` so a host app's handlers share the SDK's exact shapes.
 *
 * Truth-in-copy (law #4 / guardrail #3): the default label is "Pay with Crypto" — it makes no
 * "instant" or "free" claim. A host app on Arc (USDC = native gas, Circle Paymaster covers it) may
 * pass a truthful `label="Pay with USDC — no gas fee"`; on other chains it must not.
 */

import { type ReactNode, useEffect, useId, useMemo, useRef } from 'react';
import { usePayment } from '../hooks/usePayment.js';
import type { Access0x1Client } from '../client.js';
import type { Access0x1Error } from '../errors.js';
import {
  NATIVE_TOKEN,
  type Hex,
  type PaymentReceipt,
  type PayButtonDisabledReason,
  type QuoteResult,
  type SettledResult,
} from '../types.js';

/** Props for {@link PayButton}. */
export interface PayButtonProps {
  /** The merchant to pay. */
  merchantId: bigint;
  /** Human USD price (e.g. `29.00`). */
  usdAmount: number;
  /** The ERC-20 to pay in; omit for native. */
  token?: Hex;
  /** A human-readable order reference. */
  orderId?: string;
  /** The deployed `Access0x1Router` (required — never hardcoded). */
  routerAddress: Hex;
  /** The viem-backed client driving the payment. */
  client?: Access0x1Client;
  /** Button label in the idle state. Defaults to `"Pay with Crypto"`. */
  label?: string;
  /** Pass-through class for the host app's CSS / Tailwind. */
  className?: string;
  /**
   * The router's pay-in allowlist for this checkout, as the host already knows it from merchant
   * setup. When provided, `<PayButton>` disables itself (reason `token-not-allowed`) if the chosen
   * {@link token} is not in the list — degrading gracefully instead of clicking into a revert.
   * Omit to skip the client-side check and rely on the live `quote()` probe alone.
   */
  allowedTokens?: readonly Hex[];
  /**
   * Whether a Chainlink price feed backs the chosen {@link token} on this router. Defaults to `true`.
   * Pass `false` for a token the host knows has no configured feed: `<PayButton>` disables itself
   * (reason `no-feed`) because `quote()` would revert.
   */
  priceFeedConfigured?: boolean;
  /**
   * A block-explorer base URL (e.g. `https://testnet.arcscan.app`). When set, the success receipt's
   * tx hash is rendered as a link and threaded into {@link SettledResult.explorerUrl}.
   */
  explorerBaseUrl?: string;
  /** Label shown when the button is disabled by configuration. Defaults to a reason-specific message. */
  disabledLabel?: string;
  /** Called on every quote attempt with the typed result (gross amount, or the quote error). */
  onQuote?: (result: QuoteResult) => void;
  /** Called once the payment settles on-chain, with the receipt + a ready explorer URL. */
  onSettled?: (result: SettledResult) => void;
  /** Called with the decoded receipt on success. */
  onSuccess?: (receipt: PaymentReceipt) => void;
  /** Called with the typed error on failure. */
  onError?: (err: Access0x1Error) => void;
  /** Override the inline success node (default: "Paid — view receipt"). */
  renderSuccess?: (receipt: PaymentReceipt) => ReactNode;
  /** Override the disabled node (default: a `<button disabled>` with reason-specific copy). */
  renderDisabled?: (reason: PayButtonDisabledReason) => ReactNode;
}

/** Default, reason-specific copy for the disabled state — truthful, never blaming the buyer. */
const DISABLED_LABELS: Record<PayButtonDisabledReason, string> = {
  'no-client': 'Connect a wallet to pay',
  'no-feed': 'Payments unavailable',
  'token-not-allowed': 'Token not accepted',
  'quote-unavailable': 'Payments temporarily unavailable',
};

/**
 * Derive whether the pay flow can even start, from host-declared config alone (no async work).
 *
 * This is the *static* half of graceful degradation: it runs before any click and before any quote,
 * so a misconfigured checkout shows a disabled button immediately rather than on the first failed
 * tap. The *dynamic* half (a live `quote()` that reverts) is layered on top in the component.
 *
 * @param client            The viem client, or `undefined`.
 * @param token             The chosen pay-in token; `undefined`/{@link NATIVE_TOKEN} means native.
 * @param allowedTokens     The host-declared allowlist, if any.
 * @param priceFeedConfigured Whether a feed backs the token (defaults to `true`).
 * @returns The disabling reason, or `null` if config looks payable.
 */
function deriveConfigDisabledReason(
  client: Access0x1Client | undefined,
  token: Hex | undefined,
  allowedTokens: readonly Hex[] | undefined,
  priceFeedConfigured: boolean,
): PayButtonDisabledReason | null {
  if (client == null) return 'no-client';
  if (!priceFeedConfigured) return 'no-feed';

  // Allowlist check (case-insensitive: addresses may be checksummed or lowercase).
  if (allowedTokens != null) {
    const want = (token ?? NATIVE_TOKEN).toLowerCase();
    const allowed = allowedTokens.some((t) => t.toLowerCase() === want);
    if (!allowed) return 'token-not-allowed';
  }

  return null;
}

/**
 * Map a quote-time error code to a disabled reason. Only the codes that mean "this token/feed pair is
 * not payable" disable the button; transient or buyer-side errors (e.g. `USER_REJECTED`) do not.
 */
function quoteErrorToDisabledReason(err: Access0x1Error | null): PayButtonDisabledReason | null {
  if (err == null) return null;
  switch (err.code) {
    case 'TOKEN_NOT_ALLOWED':
      return 'token-not-allowed';
    case 'STALE_PRICE':
    case 'INVALID_PRICE':
      return 'quote-unavailable';
    default:
      return null;
  }
}

/** A tiny inline spinner (no external CSS dependency). */
function Spinner(): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-testid="access0x1-spinner"
      style={{
        display: 'inline-block',
        width: '0.85em',
        height: '0.85em',
        marginRight: '0.4em',
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: 'access0x1-spin 0.7s linear infinite',
        verticalAlign: 'middle',
      }}
    />
  );
}

/** Join an explorer base URL and a tx hash into a `/tx/<hash>` link, tolerating a trailing slash. */
function buildExplorerUrl(base: string | undefined, txHash: Hex): string | null {
  if (base == null || base.length === 0) return null;
  return `${base.replace(/\/+$/, '')}/tx/${txHash}`;
}

/**
 * The drop-in "Pay with Crypto" button.
 *
 * @param props See {@link PayButtonProps}.
 */
export function PayButton(props: PayButtonProps): ReactNode {
  const {
    merchantId,
    usdAmount,
    token,
    orderId,
    routerAddress,
    client,
    label = 'Pay with Crypto',
    className,
    allowedTokens,
    priceFeedConfigured = true,
    explorerBaseUrl,
    disabledLabel,
    onQuote,
    onSettled,
    onSuccess,
    onError,
    renderSuccess,
    renderDisabled,
  } = props;

  const { status, pay, quote, quoteError, receipt, error } = usePayment({
    merchantId,
    usdAmount,
    token,
    orderId,
    routerAddress,
    client,
    onSuccess,
    onError,
  });

  // Keep callbacks in refs so the fire-on-change effects below don't depend on caller identity
  // (a host passing inline closures must not cause spurious re-fires).
  const onQuoteRef = useRef(onQuote);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onQuoteRef.current = onQuote;
    onSettledRef.current = onSettled;
  }, [onQuote, onSettled]);

  // 8-decimal USD mirrors the hook's internal conversion; recomputed here purely for the onQuote payload.
  const usdAmount8 = useMemo(() => BigInt(Math.round(usdAmount * 1e8)), [usdAmount]);
  const quoteToken = token ?? NATIVE_TOKEN;

  // Fire onQuote exactly once per settled quote attempt (a resolved gross OR a quote error).
  useEffect(() => {
    if (quote == null && quoteError == null) return;
    onQuoteRef.current?.({
      merchantId,
      token: quoteToken,
      usdAmount8,
      grossAmount: quote,
      error: quoteError,
    });
    // Intentionally keyed only on the quote outcome (quote/quoteError); the payload's other fields
    // are derived from props that change together with a fresh quote, so re-firing on them would
    // double-emit. The callback is read from a ref, so it is deliberately not a dependency.
  }, [quote, quoteError]);

  // Fire onSettled once the receipt lands (sibling of onSuccess, adds the explorer URL).
  useEffect(() => {
    if (status !== 'success' || receipt == null) return;
    onSettledRef.current?.({
      receipt,
      explorerUrl: buildExplorerUrl(explorerBaseUrl, receipt.txHash),
    });
    // Intentionally keyed only on the settlement (status + receipt); explorerBaseUrl is folded into
    // the payload but should not by itself re-fire a settlement callback. The callback is read from a
    // ref, so it is deliberately not a dependency.
  }, [status, receipt]);

  const busy = status === 'confirm' || status === 'pending' || status === 'quoting';
  const statusId = useId();

  // Graceful degradation: a static config reason, then a runtime quote-error reason. Never disable
  // while busy/succeeded — those states own the rendering below.
  const disabledReason: PayButtonDisabledReason | null =
    status === 'success'
      ? null
      : (deriveConfigDisabledReason(client, token, allowedTokens, priceFeedConfigured) ??
        quoteErrorToDisabledReason(quoteError));

  if (status === 'success' && receipt != null) {
    const explorerUrl = buildExplorerUrl(explorerBaseUrl, receipt.txHash);
    return (
      <div className={className} data-access0x1-status="success">
        {renderSuccess != null ? (
          renderSuccess(receipt)
        ) : explorerUrl != null ? (
          <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
            Paid — view receipt
          </a>
        ) : (
          <span>Paid — view receipt</span>
        )}
      </div>
    );
  }

  // Disabled by configuration or by a non-payable quote: render a dead, non-clickable button with
  // truthful copy (or the host's override) so the buyer is never sent into a guaranteed revert.
  if (disabledReason != null) {
    if (renderDisabled != null) return renderDisabled(disabledReason);
    return (
      <button
        type="button"
        className={className}
        disabled
        aria-disabled="true"
        data-access0x1-status="disabled"
        data-access0x1-disabled-reason={disabledReason}
      >
        {disabledLabel ?? DISABLED_LABELS[disabledReason]}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy}
        aria-busy={busy}
        aria-describedby={error != null ? statusId : undefined}
        data-access0x1-status={status}
        onClick={() => {
          void pay();
        }}
      >
        {busy ? (
          <>
            <Spinner />
            {status === 'quoting' ? 'Getting price…' : 'Confirm in wallet…'}
          </>
        ) : (
          label
        )}
      </button>
      {error != null ? (
        <span id={statusId} role="alert" data-access0x1-error={error.code}>
          {error.message}
        </span>
      ) : null}
    </>
  );
}

/**
 * Internal re-export so unit tests can assert the pure derivation helpers directly (the disabled-reason
 * derivation, the quote-error mapping, and the explorer-URL builder) without rendering the component.
 * Mirrors the `__internals` seam in `../hooks/usePayment.js`; not part of the public API.
 */
export const __internals = {
  deriveConfigDisabledReason,
  quoteErrorToDisabledReason,
  buildExplorerUrl,
  DISABLED_LABELS,
};
