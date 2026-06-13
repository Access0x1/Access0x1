/**
 * @file `<PayButton>` — the drop-in payment button.
 *
 * A thin UI shell over {@link usePayment}. It is a single `<button>` with no modal/overlay by
 * default — the host app keeps full layout control via `className`. It shows a spinner while the tx
 * is in `confirm`/`pending`, an inline confirmation on success, and the typed error message on
 * failure.
 *
 * Truth-in-copy (law #4 / guardrail #3): the default label is "Pay with Crypto" — it makes no
 * "instant" or "free" claim. A host app on Arc (USDC = native gas, Circle Paymaster covers it) may
 * pass a truthful `label="Pay with USDC — no gas fee"`; on other chains it must not.
 */

import { type ReactNode, useId } from 'react';
import { usePayment } from '../hooks/usePayment.js';
import type { Access0x1Client } from '../client.js';
import type { Access0x1Error } from '../errors.js';
import type { Hex, PaymentReceipt } from '../types.js';

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
  /** Called with the decoded receipt on success. */
  onSuccess?: (receipt: PaymentReceipt) => void;
  /** Called with the typed error on failure. */
  onError?: (err: Access0x1Error) => void;
  /** Override the inline success node (default: "Paid — view receipt"). */
  renderSuccess?: (receipt: PaymentReceipt) => ReactNode;
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
    onSuccess,
    onError,
    renderSuccess,
  } = props;

  const { status, pay, receipt, error } = usePayment({
    merchantId,
    usdAmount,
    token,
    orderId,
    routerAddress,
    client,
    onSuccess,
    onError,
  });

  const busy = status === 'confirm' || status === 'pending' || status === 'quoting';
  const statusId = useId();

  if (status === 'success' && receipt != null) {
    return (
      <div className={className} data-access0x1-status="success">
        {renderSuccess != null ? renderSuccess(receipt) : <span>Paid — view receipt</span>}
      </div>
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
