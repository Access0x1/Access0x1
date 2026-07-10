import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { AskView } from '@/components/pages/AskView'

export const metadata: Metadata = {
  title: 'Ask Access0x1 — AI assistant',
  description:
    'Ask anything about Access0x1: the open, zero-custody, USD-priced onchain payments, ' +
    'agents, and commerce layer. Answers are grounded in the repo (testnet build).',
}

/** The /ask page: a grounded, judge-facing Q&A chat over the Access0x1 facts. */
export default function AskPage(): ReactNode {
  return <AskView />
}
