'use client'

import { useEffect, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * DevMode — one switch that turns the marketing page into a technical read.
 *
 * WHY. A landing page has two audiences with opposite needs. A merchant wants
 * "get paid in USDC with one link" and nothing else. A developer — or a judge with
 * five minutes — wants to know what actually settles, which contract does it, and
 * where the receipt is, and they will not take prose for an answer. Writing for one
 * loses the other, and the usual fix (a separate /docs page) means the sceptical
 * reader leaves the page that was meant to convince them.
 *
 * So the answers live INLINE, folded away. Flip the switch and every claim on the
 * page grows its own footnote: the contract, the mechanism, the honest caveat. The
 * questions get pre-answered in the place they get asked, and nobody has to sit
 * through an explanation they did not want.
 *
 * HOW IT WORKS. The toggle writes `data-devmode="on"` on <html>, and CSS reveals
 * `.dev-note` blocks. That means:
 *   - the notes are in the server-rendered HTML, so they are real content, indexed
 *     and readable without JS — not injected on demand;
 *   - flipping the switch is one attribute write, no re-render, no layout thrash
 *     on a page full of them;
 *   - the preference persists in localStorage, so a developer who turned it on stays
 *     in the technical read as they move around the site.
 *
 * Zero dependencies. One attribute, one CSS rule, one localStorage key.
 */

const STORAGE_KEY = 'access0x1:devmode'
const ATTR = 'data-devmode'

/** The switch. Place it once per page; it drives every {@link DevNote} on that page. */
export function DevModeToggle({ className }: { className?: string }): ReactNode {
  const [on, setOn] = useState(false)

  // Read the stored preference after mount. Deliberately NOT during render: the
  // server has no localStorage, and reading it in render would hydrate-mismatch.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY) === 'on'
      setOn(stored)
      document.documentElement.setAttribute(ATTR, stored ? 'on' : 'off')
    } catch {
      // Private mode / storage disabled: the toggle still works for this session.
    }
  }, [])

  function toggle(): void {
    const next = !on
    setOn(next)
    document.documentElement.setAttribute(ATTR, next ? 'on' : 'off')
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
    } catch {
      /* not fatal — the attribute above is what actually drives the UI */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      data-testid="devmode-toggle"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        on
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:border-rail hover:text-foreground',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-1.5 w-1.5 rounded-full transition-colors',
          on ? 'bg-primary' : 'bg-muted-foreground/50',
        )}
      />
      {on ? 'Developer view on' : 'Explain it like a developer'}
    </button>
  )
}

/**
 * One folded technical answer, rendered next to the claim it backs.
 *
 * Always present in the HTML; CSS decides whether it is shown. `contract` is the
 * receipt — the file in `src/` a reader can open — and `caveat` is where the
 * honest limit goes, because a technical reader trusts the page that volunteers
 * one far more than the page that does not.
 */
export function DevNote({
  contract,
  children,
  caveat,
}: {
  contract?: string
  children: ReactNode
  caveat?: string
}): ReactNode {
  return (
    <div className="dev-note mt-3 rounded-lg border border-dashed border-border bg-secondary/30 px-3 py-2 text-left">
      {contract ? (
        <code className="block font-mono text-[11px] text-primary">{contract}</code>
      ) : null}
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</p>
      {caveat ? (
        <p className="mt-1.5 text-xs leading-relaxed text-amber-600 dark:text-amber-500">
          Caveat: {caveat}
        </p>
      ) : null}
    </div>
  )
}
