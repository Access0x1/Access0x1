import { describe, expect, it } from 'vitest';

import type { MerchantBranding, MerchantInfo, PaymentSummary } from '../src/types';
import {
  brandingHeaderChildren,
  renderBrandedConfirmation,
  VERIFIED_COPY,
} from '../src/ui/brandingPanel';
import { renderInsightPanel } from '../src/ui/insightPanel';

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

/** Recursively collect the `type` of every element in a JSX tree. */
function collectTypes(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectTypes(child, acc));
    return acc;
  }
  if (node && typeof node === 'object') {
    const el = node as { type?: string; props?: Record<string, unknown> };
    if (typeof el.type === 'string') {
      acc.push(el.type);
    }
    if (el.props) {
      for (const value of Object.values(el.props)) {
        collectTypes(value, acc);
      }
    }
  }
  return acc;
}

const BRANDING: MerchantBranding = {
  merchantId: '7',
  name: "Joe's Barbershop",
  description: 'Fresh cuts & hot-towel shaves in Brooklyn',
  logoSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  brandColor: '#4f46e5',
  verified: true,
  updatedAt: 1,
};

const MERCHANT: MerchantInfo = {
  id: 7n,
  name: 'Merchant #7',
  payout: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  feeBps: 500,
  platformFeeBps: 0,
};

const SUMMARY: PaymentSummary = {
  merchantId: 7n,
  usdAmount8: 2900000000n,
  token: null,
  tokenAmount: 0n,
  orderId: '0x6f726465722d310000000000000000000000000000000000000000000000000',
  orderIdLabel: 'order-1',
  chainId: 5042002,
  chainLabel: 'Arc Testnet',
};

describe('brandingHeaderChildren', () => {
  it('renders the logo image, "Pay {name}", and the description', () => {
    const text = collectText(brandingHeaderChildren(BRANDING));
    expect(text).toContain("Pay Joe's Barbershop");
    expect(text).toContain('Fresh cuts & hot-towel shaves in Brooklyn');
    const types = collectTypes(brandingHeaderChildren(BRANDING));
    expect(types).toContain('Image');
  });

  it('shows the verified banner ONLY when verified is true (law #4)', () => {
    const verified = collectText(brandingHeaderChildren(BRANDING));
    expect(verified).toContain(VERIFIED_COPY);

    const unverified = collectText(
      brandingHeaderChildren({ ...BRANDING, verified: false }),
    );
    expect(unverified).not.toContain(VERIFIED_COPY);
  });

  it('omits the Image when there is no logo (clean fallback, no broken surface)', () => {
    const types = collectTypes(
      brandingHeaderChildren({ ...BRANDING, logoSvg: null }),
    );
    expect(types).not.toContain('Image');
    const text = collectText(
      brandingHeaderChildren({ ...BRANDING, logoSvg: null }),
    );
    expect(text).toContain("Pay Joe's Barbershop");
  });
});

describe('renderInsightPanel with branding', () => {
  it('renders the branded header above the payment insight', () => {
    const text = collectText(renderInsightPanel(SUMMARY, MERCHANT, BRANDING));
    expect(text).toContain("Pay Joe's Barbershop"); // branded header
    expect(text).toContain('$29.00'); // payment insight preserved
    expect(text).toContain('$1.45'); // fee
    expect(text).toContain('$27.55'); // net
  });

  it('uses the branding name in the Merchant row', () => {
    const text = collectText(renderInsightPanel(SUMMARY, MERCHANT, BRANDING));
    expect(text).toContain("Joe's Barbershop");
  });

  it('falls back to the plain panel with no branding (no regression)', () => {
    const text = collectText(renderInsightPanel(SUMMARY, MERCHANT));
    expect(text).toContain('Access0x1 Payment');
    expect(text).toContain('Merchant #7');
    expect(text).not.toContain('Pay Merchant #7');
  });
});

describe('renderBrandedConfirmation', () => {
  it('includes the branded header and the amount label', () => {
    const text = collectText(renderBrandedConfirmation(BRANDING, '$29.00'));
    expect(text).toContain("Pay Joe's Barbershop");
    expect(text).toContain('$29.00');
  });
});
