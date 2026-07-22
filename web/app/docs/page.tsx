import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { DocsView } from '@/components/pages/DocsView'

export const metadata: Metadata = {
  title: 'Access0x1 documentation assistant',
  description:
    'Ask a question and get an answer grounded only in the Access0x1 documentation, with the ' +
    'source file cited. Testnet build.',
}

/** The /docs page: a grounded Q&A chatbox over the Access0x1 docs/*.md corpus. */
export default function DocsPage(): ReactNode {
  return <DocsView />
}
