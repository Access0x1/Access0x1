import { BrandPreview } from '@access0x1/web'

// The "Pay {name}" live preview card, themed by the merchant's brand color.
// A leaf component that only makes sense inside its real parent — every call
// site (BrandingForm.tsx, SlugCheckoutView.tsx) wraps it in the SAME
// deliberate bright `.light` island on the dark app chassis, which flips
// --foreground/--card so BrandPreview's `text-ink`/bg-card read as a clean
// light card instead of dark-on-dark. Composed identically here.

// BrandingForm.tsx "Make it yours" live preview, mid-onboarding: name +
// description filled in, no logo uploaded yet (monogram fallback), no amount.
export const Default = () => (
  <div className="light rounded-2xl border border-border bg-card p-5">
    <BrandPreview
      name="Nightwater Coffee"
      description="Small-batch pour-over, delivered fresh."
      brandColor="#22D3EE"
    />
  </div>
)

// SlugCheckoutView.tsx's hosted checkout header: the real thing a customer
// sees, with the "Amount due" line (the DoneScreen embed example uses the
// same $29.00 figure).
export const WithAmountDue = () => (
  <div className="light rounded-2xl border border-border bg-card p-5">
    <BrandPreview
      name="Nightwater Coffee"
      description="Small-batch pour-over, delivered fresh."
      brandColor="#22D3EE"
      amountUsd="29.00"
    />
  </div>
)

// Onboarding's very first keystrokes: no description yet (component's own
// "Add a one-line description" placeholder) and the compact `sm` size used
// for tighter surfaces.
export const EmptyDescriptionSmall = () => (
  <div className="light rounded-2xl border border-border bg-card p-5">
    <BrandPreview name="Nightwater Coffee" brandColor="#F97316" size="sm" />
  </div>
)
