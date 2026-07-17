import { BrandGlyph } from '@access0x1/web'

// The default the wordmark lockup (BrandMark) draws it at.
export const Default = () => <BrandGlyph size={20} />

// The primary axis is `size` — swept across the real call sites that use the
// glyph on its own scale (BrandMark.tsx sizes it via `size={size}`; the app's
// own headers/footers/cards range from a 14px compact chip to a 24px hero mark).
export const Sizes = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
    <BrandGlyph size={14} />
    <BrandGlyph size={18} />
    <BrandGlyph size={24} />
    <BrandGlyph size={40} />
  </div>
)
