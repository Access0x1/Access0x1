'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { PayButton, type PaymentReceipt, type Access0x1Error } from '@access0x1/react';
import { CHAIN, getRouterAddress, getUsdcAddress, isEnsPayToNameEnabled } from '../access0x1.config';
import { buildAccess0x1Client, connectWallet } from './access0x1-client';
import { EnsResolutionError, resolveEnsRecipient } from './ens';

/**
 * The bundled checkout page — a working <PayButton> wired to access0x1.config.ts.
 *
 * Flow: connect an injected wallet → build the SDK client → <PayButton> runs the real
 * quote → (approve) → pay → receipt cycle on-chain. White-label: your brand is prominent,
 * Access0x1 is footer-only. Off-CEI: this pays and stops; no swap/bridge here.
 *
 * Truth-in-copy (LAW #4): the "no gas fee" label is shown ONLY on Arc, where USDC is the native
 * gas token. On any other chain the button keeps the neutral "Pay with Crypto" label.
 */

// EDIT THESE: your real merchant id (from registerMerchant) and the order's USD price.
const MERCHANT_ID = 1n;
const USD_AMOUNT = 29.0;
const ORDER_ID = 'demo-order-001';

export default function CheckoutPage(): ReactNode {
  const [account, setAccount] = useState<`0x${string}` | undefined>(undefined);
  const [configError, setConfigError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);

  // OPTIONAL ENS pay-to-name (off by default; shown only when a NEXT_PUBLIC_ENS_* knob is set).
  // The buyer can type a human name (e.g. alice.eth); we resolve it to a recipient/payout address on
  // THIS settlement chain and record it in the order reference. Empty ⇒ checkout is unchanged.
  const ensEnabled = isEnsPayToNameEnabled();
  const [ensInput, setEnsInput] = useState('');
  const [ensRecipient, setEnsRecipient] = useState<`0x${string}` | null>(null);
  const [ensResolving, setEnsResolving] = useState(false);
  const [ensError, setEnsError] = useState<string | null>(null);

  // Resolve the typed name to an address (on blur). Clears prior state first so a stale resolution is
  // never reused silently. Never invents an address: a failed resolution sets a clear error (LAW #4).
  async function resolveEns(): Promise<void> {
    const trimmed = ensInput.trim();
    setEnsRecipient(null);
    setEnsError(null);
    if (!trimmed) return; // empty ⇒ nothing to resolve; checkout stays unchanged
    setEnsResolving(true);
    try {
      // resolveEnsRecipient returns a literal 0x address unchanged (no network call) and resolves an
      // ENS/DNS name to its on-chain address — or throws if it can't (never invents one).
      const addr = await resolveEnsRecipient(trimmed, CHAIN.id);
      setEnsRecipient(addr);
    } catch (err) {
      setEnsError(
        err instanceof EnsResolutionError
          ? err.message
          : err instanceof Error
            ? `ENS resolution failed: ${err.message}`
            : 'ENS resolution failed.',
      );
    } finally {
      setEnsResolving(false);
    }
  }

  // The order reference. When the buyer resolved a pay-to-name, record the resolved recipient + the
  // typed name in the order id so the intended payout is captured on-chain (truthful, off the money
  // path — the SDK still settles to the merchant's registered payout for MERCHANT_ID).
  const orderId =
    ensEnabled && ensRecipient
      ? `${ORDER_ID}+ens:${ensInput.trim()}=${ensRecipient}`
      : ORDER_ID;

  // A typed-but-unresolved ENS name blocks pay (we never pay against an unresolved/invalid name).
  const ensBlocksPay =
    ensEnabled && ensInput.trim().length > 0 && (!ensRecipient || Boolean(ensError));

  // Resolve the router address from env once; surface a clear message if it is unset.
  const routerAddress = useMemo(() => {
    try {
      return getRouterAddress();
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }, []);

  const usdc = getUsdcAddress(); // undefined → pay in native token (USDC on Arc)
  const client = useMemo(() => buildAccess0x1Client(account), [account]);

  // Arc-only truthful "no gas fee" copy (USDC is native gas there). Never on other chains.
  // CHAIN.key is a single literal (chosen at scaffold time); compare as string so this stays
  // type-valid whatever chain was scaffolded (avoids TS2367 on base/zksync).
  const payLabel =
    (CHAIN.key as string) === 'arc' ? 'Pay with USDC — no gas fee' : 'Pay with Crypto';

  async function handleConnect(): Promise<void> {
    const acct = await connectWallet();
    if (!acct) {
      setConfigError('No injected wallet found. Install MetaMask (or similar) to pay.');
      return;
    }
    setAccount(acct);
  }

  return (
    <main style={styles.main}>
      {/* Keyboard focus ring for the connect button. Inline styles can't express
          :focus-visible, so this scoped rule gives keyboard users a visible ring
          without showing an outline on mouse click. */}
      <style>{
        '.a0x1-connect:focus-visible{outline:2px solid #818cf8;outline-offset:2px;}'
      }</style>
      <section style={styles.card}>
        <header style={styles.header}>
          <h1 style={styles.brand}>{'{{PROJECT_NAME}}'}</h1>
          <p style={styles.sub}>
            Pay with crypto · {CHAIN.name} <span style={styles.dim}>(chain {CHAIN.id})</span>
          </p>
        </header>

        <div style={styles.price}>${USD_AMOUNT.toFixed(2)}</div>
        <p style={styles.dim}>USD-priced via Chainlink — settled in one on-chain tx.</p>

        {ensEnabled ? (
          <div style={styles.ensField}>
            <label htmlFor="a0x1-ens" style={styles.dim}>
              Pay to a name (optional)
            </label>
            <input
              id="a0x1-ens"
              type="text"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              placeholder="alice.eth or 0x…"
              value={ensInput}
              onChange={(e) => {
                setEnsInput(e.target.value);
                setEnsRecipient(null);
                setEnsError(null);
              }}
              onBlur={() => void resolveEns()}
              style={styles.ensInput}
            />
            {ensResolving ? (
              <span style={styles.dim}>Resolving…</span>
            ) : ensRecipient ? (
              <span style={styles.ensOk}>Resolves to {ensRecipient}</span>
            ) : ensError ? (
              <span style={styles.error} role="alert">
                {ensError}
              </span>
            ) : null}
          </div>
        ) : null}

        {configError ? (
          <p style={styles.error} role="alert">
            {configError}
          </p>
        ) : null}

        {!account ? (
          <button
            type="button"
            className="a0x1-connect"
            style={styles.connect}
            onClick={() => void handleConnect()}
          >
            Connect wallet
          </button>
        ) : receipt ? (
          <div style={styles.success}>
            <strong>Paid.</strong>
            <div style={styles.dim}>tx {receipt.txHash}</div>
          </div>
        ) : routerAddress ? (
          ensBlocksPay ? (
            // A pay-to-name was typed but hasn't resolved — never pay against an unresolved name.
            <button type="button" style={styles.connect} disabled aria-disabled>
              {ensResolving ? 'Resolving name…' : 'Enter a resolvable name to pay'}
            </button>
          ) : (
            <PayButton
              merchantId={MERCHANT_ID}
              usdAmount={USD_AMOUNT}
              token={usdc}
              orderId={orderId}
              routerAddress={routerAddress}
              client={client}
              label={payLabel}
              className=""
              onSuccess={(r) => setReceipt(r)}
              onError={(e: Access0x1Error) => setConfigError(`${e.code}: ${e.message}`)}
            />
          )
        ) : (
          <p style={styles.dim}>
            Configure your router (see .env.local) to enable checkout.
          </p>
        )}

        <footer style={styles.footer}>
          <span>Powered by Access0x1 · non-custodial</span>
        </footer>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
    background: '#0b0b10',
    color: '#f9fafb',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    padding: '24px',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    background: '#15151d',
    border: '1px solid #26262f',
    borderRadius: 16,
    padding: 28,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  header: { display: 'flex', flexDirection: 'column', gap: 4 },
  brand: { fontSize: 24, fontWeight: 600, margin: 0 },
  sub: { fontSize: 14, color: '#9ca3af', margin: 0 },
  dim: { fontSize: 13, color: '#9ca3af' },
  price: { fontSize: 44, fontWeight: 700, marginTop: 8 },
  connect: {
    background: '#4F46E5',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    padding: '12px 16px',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
  success: { display: 'flex', flexDirection: 'column', gap: 4 },
  error: { color: '#f87171', fontSize: 14, wordBreak: 'break-word' },
  ensField: { display: 'flex', flexDirection: 'column', gap: 6 },
  ensInput: {
    background: '#0f0f16',
    color: '#f9fafb',
    border: '1px solid #26262f',
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: 14,
    fontFamily: 'inherit',
  },
  ensOk: { color: '#34d399', fontSize: 12, wordBreak: 'break-all' },
  footer: {
    borderTop: '1px solid #26262f',
    paddingTop: 14,
    textAlign: 'center',
    fontSize: 12,
    color: '#6b7280',
  },
};
