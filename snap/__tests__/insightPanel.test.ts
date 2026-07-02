import { describe, expect, it } from 'vitest';

import {
  computeFeeSplit,
  renderInsightPanel,
  tokenLabel,
  truncateAddress,
} from '../src/ui/insightPanel';
import type { MerchantInfo, PaymentSummary } from '../src/types';

const MERCHANT: MerchantInfo = {
  id: 7n,
  name: 'demo.access0x1.eth',
  payout: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  feeBps: 500, // 5% merchant surcharge
  platformFeeBps: 100, // 1% platform fee — the panel must show the 6% TOTAL
};

const NATIVE_SUMMARY: PaymentSummary = {
  merchantId: 7n,
  usdAmount8: 2900000000n,
  token: null,
  tokenAmount: 0n,
  orderId: '0x6f726465722d310000000000000000000000000000000000000000000000000',
  orderIdLabel: 'order-1',
  chainId: 5042002,
  chainLabel: 'Arc Testnet',
};

const TOKEN_SUMMARY: PaymentSummary = {
  ...NATIVE_SUMMARY,
  token: '0x1111111111111111111111111111111111111111',
  chainId: 84532,
  chainLabel: 'Base Sepolia',
};

/** Recursively collect every string in a JSX element tree. */
function collectText(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectText(child, acc));
    return acc;
  }
  if (node && typeof node === 'object') {
    const el = node as { props?: Record<string, unknown> };
    if (el.props) {
      for (const value of Object.values(el.props)) {
        collectText(value, acc);
      }
    }
  }
  return acc;
}

describe('truncateAddress', () => {
  it('truncates to 0x prefix … last 4', () => {
    expect(truncateAddress('0x1111111111111111111111111111111111111111')).toBe(
      '0x1111…1111',
    );
  });
});

describe('tokenLabel', () => {
  it('returns Native for a null token', () => {
    expect(tokenLabel(null)).toBe('Native');
  });

  it('returns the truncated address for an ERC-20 token', () => {
    expect(tokenLabel('0x1111111111111111111111111111111111111111')).toBe(
      '0x1111…1111',
    );
  });
});

describe('computeFeeSplit', () => {
  it('computes fee = usd * bps / 10000 and net = usd - fee', () => {
    const { fee, net } = computeFeeSplit(2900000000n, 500);
    expect(fee).toBe(145000000n); // 5% of $29.00 = $1.45
    expect(net).toBe(2755000000n); // $27.55
  });

  it('returns zero fee for a zero-bps merchant', () => {
    const { fee, net } = computeFeeSplit(100000000n, 0);
    expect(fee).toBe(0n);
    expect(net).toBe(100000000n);
  });
});

describe('renderInsightPanel', () => {
  it('includes the USD amount, merchant name, chain label, and order label for payNative', () => {
    const text = collectText(renderInsightPanel(NATIVE_SUMMARY, MERCHANT));
    expect(text).toContain('$29.00');
    expect(text).toContain('demo.access0x1.eth');
    expect(text).toContain('Arc Testnet');
    expect(text).toContain('order-1');
    expect(text).toContain('Native');
  });

  it('shows the fee split using platformFeeBps + merchant feeBps (the true total)', () => {
    const text = collectText(renderInsightPanel(NATIVE_SUMMARY, MERCHANT));
    // 6% of $29.00 = $1.74 total fee (1% platform + 5% merchant), NOT 5%/$1.45.
    expect(text).toContain('$1.74'); // fee
    expect(text).toContain('$27.26'); // net
  });

  it('shows the platform fee even when the merchant surcharge is zero (the bug this guards)', () => {
    // feeBps=0 with a 1% platform fee: pre-fix the panel showed $0.00 fee / $29.00
    // net — both wrong. It must show the $0.29 platform cut and the $28.71 net.
    const zeroSurcharge: MerchantInfo = { ...MERCHANT, feeBps: 0, platformFeeBps: 100 };
    const text = collectText(renderInsightPanel(NATIVE_SUMMARY, zeroSurcharge));
    expect(text).toContain('$0.29'); // 1% of $29.00 platform fee (pre-fix showed $0.00)
    expect(text).toContain('$28.71'); // net (pre-fix showed the full $29.00)
  });

  it('shows the truncated token address for payToken', () => {
    const text = collectText(renderInsightPanel(TOKEN_SUMMARY, MERCHANT));
    expect(text).toContain('0x1111…1111');
    expect(text).toContain('Base Sepolia');
  });

  it('never includes the words "anonymous" or "untraceable" (law #4)', () => {
    const joined = collectText(renderInsightPanel(NATIVE_SUMMARY, MERCHANT))
      .join(' ')
      .toLowerCase();
    expect(joined).not.toContain('anonymous');
    expect(joined).not.toContain('untraceable');
  });
});
