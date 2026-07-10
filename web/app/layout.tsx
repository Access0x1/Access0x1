import type { Metadata, Viewport } from 'next'
import { Inter, Space_Grotesk } from 'next/font/google'
import type { ReactNode } from 'react'
import './globals.css'
import { Providers } from './providers'

/*
 * Brand typography (BRAND.md): Inter for UI/body, a tight geometric sans
 * (Space Grotesk) for display/wordmark. Loaded via next/font so they self-host
 * (no layout shift, no external request). Exposed as CSS variables consumed by
 * the Tailwind font families (`font-sans` -> Inter, `font-display` -> Space
 * Grotesk).
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
})

/*
 * Site metadata. The icon/manifest links come from the app-dir file conventions
 * (app/favicon.ico, app/icon.png, app/apple-icon.png, app/manifest.ts), so they
 * are NOT repeated here — Next injects them automatically. What this block owns
 * is the canonical base URL, the shared title/description, and the social cards
 * (Open Graph + Twitter) that the convention files can't express.
 */
const SITE_URL = 'https://access0x1.click'
const TITLE = 'Access0x1 — accept USD-priced onchain payments with one link'
const DESCRIPTION =
  'Onboard once, share a link, get paid in USDC. Zero custody — every payment settles ' +
  'merchant to payout in a single transaction. Powered by the open-source Access0x1 router.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: 'Access0x1',
  openGraph: {
    type: 'website',
    siteName: 'Access0x1',
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Access0x1 — the bridge mark on night-water, with the wordmark and tagline.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og.png'],
  },
}

/*
 * Viewport owns theme-color in Next 15 (moved out of `metadata`). Night-water
 * #0B1020 so the mobile address bar / PWA chrome match the brand chassis.
 */
export const viewport: Viewport = {
  themeColor: '#0B1020',
}

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
