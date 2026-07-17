#!/bin/sh
# design-sync buildCmd — regenerates every input the converter reads that
# isn't checked in as-is: the compiled Tailwind CSS, the pinned brand font
# vars, and a filtered copy of components/ (cfg.srcDir points here, not at
# the real components/ tree).
set -e
cd "$(dirname "$0")/.."

# 1. Tailwind: globals.css has no utility classes until PostCSS expands them
# against actual class usage across the repo, so ship the compiled output.
# Uses .design-sync/tailwind.config.ts (extends the real config's `content`
# with .design-sync/previews/**/*.tsx) — the real tailwind.config.ts only
# scans app/, components/, lib/, so any utility class used ONLY in an
# authored preview compiles to nothing without this (confirmed on
# Progress.tsx's bg-[hsl(var(--success))]: silently zero visual effect).
npx tailwindcss -i app/globals.css -o .design-sync/.cache/compiled.css -c .design-sync/tailwind.config.ts
cat >> .design-sync/.cache/compiled.css <<'EOF'

/* design-sync: real font-family for the next/font-injected variables below */
:root {
  --font-sans: 'Inter Variable';
  --font-display: 'Space Grotesk Variable';
}
EOF
# next/font injects --font-sans/--font-display as hashed local family names
# at Next.js build time — invisible to a static synth-entry build, so without
# the block above those vars are undefined and every font-sans/font-display
# utility silently falls back to the system font stack. This pins them to the
# same public Google Fonts families (via @fontsource-variable, wired through
# cfg.extraFonts so the real woff2s ship too), not a substitute — just sourced
# as static files instead of next/font's runtime injection.

# 2. Filtered components/ copy: the converter's synth-entry mode (no dist/)
# bundles EVERY .tsx/.jsx file under cfg.srcDir into _ds_bundle.js, regardless
# of cfg.componentSrcMap — that field only prunes the recognized-component
# INDEX, not the underlying file from the bundle (there's no srcExclude-style
# config key). The 15 Dynamic-gated components excluded via componentSrcMap
# (see NOTES.md "Bundle size") still dragged in the full
# @dynamic-labs/sdk-react-core dependency graph (WalletConnect/Reown,
# MetaMask multichain, Coinbase, Turnkey, Ably — 58% of the bundle, see
# NOTES.md) until their FILES were kept out of the scanned tree entirely.
# This copies components/ into .design-sync/.cache/components-filtered/ minus
# those 15 files; cfg.srcDir points at the copy. The real app source under
# web/components/ is never touched.
FILTERED=.design-sync/.cache/components-filtered
rm -rf "$FILTERED"
mkdir -p "$FILTERED"
cp -r components/. "$FILTERED/"
for f in \
  ConnectButton.tsx \
  GatewayBalanceCard.tsx \
  IdentityChip.tsx \
  NetworkBadge.tsx \
  RegisterForm.tsx \
  SponsorPanel.tsx \
  branding/BrandingForm.tsx \
  branding/CheckoutModeForm.tsx \
  contracts/ContractPanel.tsx \
  journey/SellableForms.tsx \
  pages/DashboardView.tsx \
  pages/JourneyView.tsx \
  pages/OnboardView.tsx \
  verification/VerificationLevelsPanel.tsx \
  verification/VerificationStack.tsx \
; do
  rm -f "$FILTERED/$f"
done

# Strip test files from the copy. The converter never bundles them (its walk
# excludes .test/.spec/.stories), but `cp -r` copies them and vitest's default
# include glob then COLLECTS the copies — whose relative imports dangle when
# their subject was filtered out above — failing `npm run test` (the repo gate)
# with 4 phantom collection errors. Tests belong to the real tree only.
find "$FILTERED" -type d -name "__tests__" -exec rm -rf {} + 2>/dev/null || true
find "$FILTERED" -type f \( -name "*.test.*" -o -name "*.spec.*" \) -delete
