'use client'

/**
 * LocalePrompt — the resilient "you're in Portugal but the page is English, want
 * to switch?" ask. It NEVER forces a locale: the server already renders the
 * visitor's explicit language; this only OFFERS the geo-suggested one, once.
 *
 * `offer` (from getLocaleContext, server-side) is the locale to propose, or null.
 * Accepting POSTs /api/locale (server sets the cookie — the repo forbids
 * client-side cookie writes) then reloads, exactly like LanguageSwitcher.
 * Dismissing remembers the choice in localStorage so it never nags again.
 *
 * Resilient by construction: no offer, storage blocked, or a network hiccup all
 * degrade to "do nothing / keep the current locale" — it can never throw or
 * block the page render.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { LocaleCode } from '@/lib/i18n/config'

// Offer copy is shown in the TARGET language (we're offering a language the
// visitor is NOT currently seeing), so it is keyed by the offered locale, not the
// page locale. Add an entry here when a new locale becomes geo-offerable.
const OFFER_COPY: Partial<Record<LocaleCode, { q: string; yes: string; no: string }>> = {
  pt: {
    q: 'Está em Portugal. Prefere ver este site em Português?',
    yes: 'Ver em Português',
    no: 'Manter em inglês',
  },
}

const DISMISS_KEY = 'a0x1:locale-offer-dismissed'

export function LocalePrompt({ offer }: { offer: LocaleCode | null }): ReactNode {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!offer || !OFFER_COPY[offer]) return
    try {
      if (localStorage.getItem(DISMISS_KEY) === offer) return
    } catch {
      // storage blocked (private mode / policy) — just show; never throw.
    }
    setShow(true)
  }, [offer])

  if (!show || !offer) return null
  const copy = OFFER_COPY[offer]
  if (!copy) return null
  // Capture the narrowed value so the closures below keep the non-null type.
  const chosen: LocaleCode = offer

  async function accept(): Promise<void> {
    try {
      await fetch('/api/locale', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: chosen }),
      })
    } catch {
      // network hiccup — fall through to reload; the server keeps the current locale.
    }
    window.location.reload()
  }

  function dismiss(): void {
    try {
      localStorage.setItem(DISMISS_KEY, chosen)
    } catch {
      // storage blocked — dismiss for this render only; no persistence, no throw.
    }
    setShow(false)
  }

  return (
    <div
      role="dialog"
      aria-label={copy.q}
      className="fixed inset-x-0 bottom-0 z-50 mx-auto mb-4 flex max-w-md flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm text-foreground">{copy.q}</p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => {
            void accept()
          }}
          className="rounded border border-primary bg-primary/15 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-primary/25"
        >
          {copy.yes}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {copy.no}
        </button>
      </div>
    </div>
  )
}

export default LocalePrompt
