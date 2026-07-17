import { BrandMark } from '@access0x1/web'

// components/marketing/Hero.tsx's lockup — the largest real call site (size 24).
export const Default = () => <BrandMark size={24} />

// The primary axis is `size` — matches the real range across the app:
// CheckoutCard/SlugCheckoutView use 14 for a compact "Powered by" footer line,
// app/page.tsx uses 16, the dashboard/settings/verify pages use 18, and
// app/vision/page.tsx uses 20.
export const Sizes = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
    <BrandMark size={14} />
    <BrandMark size={16} />
    <BrandMark size={18} />
    <BrandMark size={20} />
  </div>
)

// withWordmark=false — the glyph-only lockup, e.g. a favicon-scale header slot.
export const GlyphOnly = () => <BrandMark size={24} withWordmark={false} />
