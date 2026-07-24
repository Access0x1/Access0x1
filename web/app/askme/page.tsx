import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { DocsAssistant } from '@/components/DocsAssistant'
import { BrandMark } from '@/components/BrandMark'

export const metadata: Metadata = {
  title: 'Ask Access0x1',
  description:
    'Ask anything about Access0x1 and get a short answer, cited to the documentation. Testnet build.',
}

/**
 * `/askme` — the short-answer front door.
 *
 * WHY THIS EXISTS SEPARATELY FROM `/docs`. Same assistant, different promise.
 * `/docs` is the documentation surface: it names itself as documentation and a
 * reader arrives expecting to read. `/askme` is the link you hand someone who
 * has ONE question and no interest in a manual — a booth visitor, a judge, a
 * merchant deciding in ninety seconds. So the page is one input and nothing
 * else: no feature list, no preamble, no "welcome to" paragraph competing with
 * the box the visitor actually came for.
 *
 * The brevity is enforced where it actually binds — rule 6 of
 * {@link DOCS_GROUNDING_INSTRUCTION} caps answers at three sentences — not by
 * styling a long answer into a small box. A short page wrapped around a
 * five-paragraph reply would still be five paragraphs.
 *
 * Deliberately reuses {@link DocsAssistant} rather than forking a second chat
 * component: the streaming, the capability gate, the fail-soft `not_configured`
 * path and the rate limiting are all load-bearing and already tested. A second
 * copy would drift, and the copy that drifts is always the one in front of the
 * visitor.
 */
export default function AskMePage(): ReactNode {
  return (
    <main
      data-testid="askme-view"
      className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-4 py-12"
    >
      {/* One line of identity, then straight to the box. The mark carries the
          brand so no headline has to. */}
      <div className="flex flex-col items-center gap-3 text-center">
        <BrandMark size={22} />
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Ask anything</h1>
        <p className="text-sm text-muted-foreground">
          Short answers, cited to the docs. Testnet build.
        </p>
      </div>

      <DocsAssistant />

      {/* The escape hatch for the reader who DOES want the manual — small, last,
          and out of the way of the person who does not. */}
      <p className="text-center text-xs text-muted-foreground">
        Want the detail?{' '}
        <a href="/docs" className="underline transition hover:text-foreground">
          Read the docs
        </a>
      </p>
    </main>
  )
}
