import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: '{{PROJECT_NAME}} — Access0x1 checkout',
  description: 'Non-custodial, USD-priced crypto checkout on {{CHAIN_NAME}}.',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
