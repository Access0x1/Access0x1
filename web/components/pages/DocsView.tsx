import type { ReactNode } from 'react'

import { DocsAssistant } from '@/components/DocsAssistant'

/**
 * DocsView — the /docs page: a single, clear entry point to the documentation
 * assistant on the app chassis. It is a thin presentational shell (no hooks) that
 * renders the {@link DocsAssistant} chatbox under a page header, so the whole
 * chat surface — capability gate, streaming, fail-soft — lives in that one client
 * component and this stays server-renderable.
 */
export function DocsView(): ReactNode {
  return (
    <main
      data-testid="docs-view"
      className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10 sm:py-16"
    >
      <header className="flex flex-col gap-2">
        <span className="text-xs font-mono uppercase tracking-widest text-[var(--ax1-rail)]">
          Documentation
        </span>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Access0x1 documentation assistant
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Ask a question and get an answer grounded only in the Access0x1 documentation, with the
          source file cited. Testnet build.
        </p>
      </header>

      <DocsAssistant />

      <footer className="mt-auto pt-6 text-xs text-muted-foreground">
        <a href="/onboard" className="underline transition hover:text-foreground">
          ← Back to Access0x1
        </a>
      </footer>
    </main>
  )
}
