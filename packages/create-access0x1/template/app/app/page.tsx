'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { PayButton, type PaymentReceipt, type Access0x1Error } from '@access0x1/react';
import { CHAIN, getRouterAddress, getUsdcAddress } from '../access0x1.config';
import { buildAccess0x1Client, connectWallet } from './access0x1-client';

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
  const payLabel = CHAIN.key === 'arc' ? 'Pay with USDC — no gas fee' : 'Pay with Crypto';

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
      <section style={styles.card}>
        <header style={styles.header}>
          <h1 style={styles.brand}>{'{{PROJECT_NAME}}'}</h1>
          <p style={styles.sub}>
            Pay with crypto · {CHAIN.name} <span style={styles.dim}>(chain {CHAIN.id})</span>
          </p>
        </header>

        <div style={styles.price}>${USD_AMOUNT.toFixed(2)}</div>
        <p style={styles.dim}>USD-priced via Chainlink — settled in one on-chain tx.</p>

        {configError ? (
          <p style={styles.error} role="alert">
            {configError}
          </p>
        ) : null}

        {!account ? (
          <button type="button" style={styles.connect} onClick={() => void handleConnect()}>
            Connect wallet
          </button>
        ) : receipt ? (
          <div style={styles.success}>
            <strong>Paid.</strong>
            <div style={styles.dim}>tx {receipt.txHash}</div>
          </div>
        ) : routerAddress ? (
          <PayButton
            merchantId={MERCHANT_ID}
            usdAmount={USD_AMOUNT}
            token={usdc}
            orderId={ORDER_ID}
            routerAddress={routerAddress}
            client={client}
            label={payLabel}
            className=""
            onSuccess={(r) => setReceipt(r)}
            onError={(e: Access0x1Error) => setConfigError(`${e.code}: ${e.message}`)}
          />
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
  error: { color: '#f87171', fontSize: 14 },
  footer: {
    borderTop: '1px solid #26262f',
    paddingTop: 14,
    textAlign: 'center',
    fontSize: 12,
    color: '#6b7280',
  },
};
