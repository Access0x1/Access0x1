import type { Metadata } from 'next'
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

export const metadata: Metadata = {
  title: 'Access0x1 — accept USD-priced crypto with one link',
  description:
    'Onboard once, share a link, get paid in USDC. Zero custody — every payment settles ' +
    'merchant to payout in a single transaction. Powered by the open-source Access0x1 router.',
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
