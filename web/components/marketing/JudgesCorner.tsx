/**
 * JudgesCorner.tsx — "don't take our word for it" — the ask-the-repo section.
 *
 * The landing page above this section is claims; this section is the receipts
 * counter. It points a judge (or any sceptical reader) at the LIVE docs-grounded
 * assistant (`/ask`), which answers from the repo's own docs corpus and says
 * "not in the docs" rather than invent — exactly the honesty law the rest of
 * the product runs on, applied to marketing.
 *
 * Static server component: no hooks, no client bundle weight, renders anywhere
 * (design-sync included). Suggested prompts are plain links that prefill the
 * ask page via `?q=`.
 */
import type { ReactNode } from 'react'

import type { Dictionary } from '@/lib/i18n/get-dictionary'

/** The judges section: heading, honest framing, tap-to-ask prompts, one CTA. */
export function JudgesCorner({ judges }: { judges: Dictionary['judges'] }): ReactNode {
  return (
    <section className="mx-auto w-full max-w-4xl px-6 py-14" aria-labelledby="judges-heading">
      <h2
        id="judges-heading"
        className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
      >
        {judges.heading}
      </h2>
      <p className="mt-3 max-w-2xl text-muted-foreground">{judges.sub}</p>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {judges.prompts.map((prompt) => (
          <li key={prompt}>
            <a
              href={`/ask?q=${encodeURIComponent(prompt)}`}
              className="block rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground transition-colors hover:border-foreground/30"
            >
              <span aria-hidden className="mr-2">
                ❓
              </span>
              {prompt}
            </a>
          </li>
        ))}
      </ul>

      <div className="mt-6">
        <a
          href="/ask"
          className="inline-flex items-center rounded-full border border-foreground/20 px-5 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-foreground/5"
        >
          {judges.cta} →
        </a>
      </div>
    </section>
  )
}
