import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: 'Access0x1 — accept USD-priced crypto with one link',
  description:
    'Onboard once, share a link, get paid in USDC. Zero custody — every payment settles ' +
    'merchant to payout in a single transaction. Powered by the open-source Access0x1 router.',
}

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
