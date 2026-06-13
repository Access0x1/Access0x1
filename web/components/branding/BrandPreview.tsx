'use client'

import type { ReactNode } from 'react'

/**
 * BrandPreview — the live "Pay {name}" + logo + description card, themed by the
 * merchant's brand color (ADR D2 step 3 live-preview law / D4 a hosted-page
 * header). Used in TWO places:
 *   - the "Make it yours" onboarding screen (shows the result as they type),
 *   - the hosted checkout page header (the real thing the customer sees).
 *
 * The logo is a sanitized inline SVG string. It is rendered with
 * `dangerouslySetInnerHTML` ONLY because every path that produces it runs
 * through the server-side sanitizer (`lib/branding/logo.ts` — scripts/handlers
 * stripped) or is a self-generated monogram. The brand color is re-normalized to
 * a safe hex by the caller before it reaches an inline style (CR law / ADR D3).
 */
export function BrandPreview({
  name,
  description,
  logoSvg,
  brandColor,
  amountUsd,
  size = 'md',
}: {
  name: string
  description?: string
  /** Sanitized inline SVG string, or empty to show no mark. */
  logoSvg?: string
  /** A validated 6/8-char hex. */
  brandColor: string
  /** Optional "$29.00" to show a Pay-amount line (checkout); omit for preview. */
  amountUsd?: string
  size?: 'sm' | 'md'
}): ReactNode {
  const logoBox = size === 'sm' ? 40 : 56
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {logoSvg ? (
          <span
            className="inline-block overflow-hidden rounded-xl"
            style={{ width: logoBox, height: logoBox }}
            // Sanitized inline SVG (server-scrubbed). See component doc.
            dangerouslySetInnerHTML={{ __html: scaleSvg(logoSvg, logoBox) }}
          />
        ) : (
          <span
            className="inline-flex items-center justify-center rounded-xl font-semibold text-white"
            style={{ width: logoBox, height: logoBox, background: brandColor }}
          >
            {(name.trim()[0] ?? '·').toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-ink">
            Pay {name.trim() || 'your business'}
          </p>
          {description ? (
            <p className="truncate text-sm text-neutral-500">{description}</p>
          ) : (
            <p className="text-sm text-neutral-400">Add a one-line description</p>
          )}
        </div>
      </div>

      {amountUsd ? (
        <div
          className="rounded-xl px-4 py-3 text-white"
          style={{ background: brandColor }}
        >
          <span className="text-sm opacity-90">Amount due</span>
          <p className="text-3xl font-semibold">${amountUsd}</p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Force the inline SVG to render at a fixed pixel box. The sanitized logo SVGs
 * carry their own width/height; we override them to fit the preview/checkout
 * slot without distorting (the viewBox preserves aspect). Pure string edit; the
 * SVG was already sanitized server-side.
 */
function scaleSvg(svg: string, px: number): string {
  return svg
    .replace(/width="[^"]*"/, `width="${px}"`)
    .replace(/height="[^"]*"/, `height="${px}"`)
}
