# Third-Party Licenses — CSS / styling / fonts / icons / visual assets

Access0x1 is open source under the [MIT License](./LICENSE) (Copyright (c) 2026
Access0x1).

This file documents the licensing of every **CSS / styling / font / icon /
visual-asset** dependency and committed asset in the repository, so that a judge
or downstream user can confirm the entire visual surface is permissive open
source. It was produced by a read-only audit of `web/`, `packages/react/`,
`snap/`, `web/public/embed.js`, and all committed images/SVGs/fonts.

**Verdict: the entire CSS / styling / font / icon / visual-asset surface is
permissive open source (MIT / ISC / self-authored MIT). No proprietary,
paid, NonCommercial (CC-NC), or attribution-encumbered font or icon set is
used anywhere. No attribution obligation applies to the styling surface.**

## Styling toolchain (build-time, `web/`)

| Dependency | Version (spec) | License | Role | Asset shipped? |
|---|---|---|---|---|
| `tailwindcss` | ^3.4.17 | MIT | Utility CSS engine (only `@tailwind base/components/utilities` directives are used; config has no third-party plugins) | No — generates our own utility classes |
| `autoprefixer` | ^10.4.20 | MIT | PostCSS vendor-prefixing | No |
| `postcss` | ^8.4.49 | MIT | CSS transform pipeline | No |

License strings above were read directly from `web/package-lock.json`
(`license: "MIT"` for each). Tailwind, autoprefixer, and PostCSS are all
canonically MIT.

## Fonts

**None embedded or downloaded.** The repository ships **no** font files
(`.woff`, `.woff2`, `.ttf`, `.otf`, `.eot`) and uses **no** `next/font`, no
`@font-face`, no `@import`, and no Google Fonts / CDN `<link>`.

Every place that sets a typeface uses the **OS / system-ui font stack**, which
renders the user's already-installed operating-system fonts and carries no
licensing obligation:

- `web/app/globals.css` — relies on browser default plus `-webkit-font-smoothing`.
- `web/public/embed.js` — `font: 600 14px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif`.
- `web/lib/branding/logo.ts` (generated monogram SVG) — `font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif"`.

> Note: `Segoe UI` and `Roboto` named in the stack are NOT bundled — they are
> only requested if the viewer's OS already has them; otherwise the stack falls
> back to `system-ui`. No font binary is distributed.

## Icons

**No icon library is a dependency.** There is no `lucide`, `@heroicons`,
`@fortawesome` / Font Awesome, `react-icons`, `@radix-ui/react-icons`, or any
icon-font package in any `package.json` or lockfile. No attribution-required
icon set (e.g. Font Awesome Free CC-BY-4.0, or Flaticon) is present.

All icon-like graphics are **hand-authored geometric SVG** by the project:

- `snap/images/icon.svg` — the Access0x1 "access plug" mark, drawn from plain
  `<rect>`/`<circle>`/`<path>` primitives (no traced third-party glyph paths).
  Original work, MIT (covered by the repo LICENSE).
- `web/components/PayButton`-family spinner (`packages/react/src/components/PayButton.tsx`)
  — an inline CSS-border spinner, explicitly "no external CSS dependency".
- `web/lib/branding/logo.ts` — server-generated monogram SVG from initials +
  brand color (original code).

## Committed visual assets (images / SVG)

| Path | Type | Provenance | License |
|---|---|---|---|
| `snap/images/icon.svg` | SVG | Original Access0x1 brand mark (geometric `<rect>` glyph, see file comment) | MIT (repo LICENSE) |

This is the **only** committed image/SVG/font asset in the repository (outside
of `node_modules`, `.git`, and the Foundry `lib/` submodules). There are no
committed `.png` / `.jpg` / `.gif` / `.webp` / `.ico` / `.avif` files and no
bare images of unknown provenance.

## Component / SDK styling surface (runtime, self-authored)

| Surface | How it styles | License |
|---|---|---|
| `web/public/embed.js` (One-Tag Checkout) | Self-authored scoped `<style>` injected under `.a0x1-btn`, CSS custom properties, system-ui font. Zero external dependency. | MIT (ours) |
| `packages/react` (`@access0x1/react` SDK) | Inline React `style={{...}}` + merchant-supplied `className`; ships no `.css`, no font, no icon | MIT (ours) |
| `snap` (`@access0x1/snap` MetaMask Snap) | UI built only from MetaMask `@metamask/snaps-sdk/jsx` primitives (`Box`, `Button`, `Heading`, `Text`, `Row`, `Link`), which MetaMask renders in its own wallet chrome | MIT (ours); snaps-sdk is MIT (MetaMask) |

## Notes on the broader dependency tree (informational, not styling)

A full scan of `web/package-lock.json` (1,385 packages) found the tree
overwhelmingly permissive (MIT / Apache-2.0 / ISC / BSD / 0BSD). A few
transitive **runtime** dependencies carry non-MIT-but-still-OSS licenses; none
are styling / CSS / font / icon dependencies and none affect the visual
surface:

- `caniuse-lite` — **CC-BY-4.0** — browser-support **data table** consumed by
  Autoprefixer/Browserslist at build time; ships no CSS/font/icon. Its
  attribution is satisfied by the bundled LICENSE in the package.
- `@img/sharp-libvips*` — **LGPL-3.0-or-later** — Next.js's native image-
  optimizer binary (dynamically linked; LGPL-compliant). Not a styling dep.
- `@ethereumjs/*`, `axe-core`, `webextension-polyfill` — **MPL-2.0** — crypto /
  test / polyfill runtime deps. Not styling.
- `@reown/appkit-*`, `@walletconnect/*`, `@metamask/*-ui` — "SEE LICENSE IN
  LICENSE(.md)" (Apache-2.0 in their bundled license files) — wallet-connection
  SDK UI pulled in transitively by `wagmi` / `@dynamic-labs`. These render their
  own wallet modals; they are not part of Access0x1's authored CSS surface.

These are listed for completeness; they do **not** change the verdict that the
CSS / styling / font / icon / visual-asset surface is permissive open source.
