'use client'

/**
 * LanguageSwitcher — the visible locale control. Sets the `access0x1_lang`
 * cookie via POST /api/locale (server-side; the repo forbids client-side
 * document.cookie writes) then reloads so the server re-renders the marketing
 * pages in the chosen locale. Deriving its options from LOCALES means adding a
 * language is dictionary + config only — no edit here.
 */
import type { ReactNode } from 'react'

import { LOCALES, LOCALE_META, type LocaleCode } from '@/lib/i18n/config'

export function LanguageSwitcher({
  active,
  label,
}: {
  active: LocaleCode
  label: string
}): ReactNode {
  async function choose(code: LocaleCode): Promise<void> {
    if (code === active) return
    await fetch('/api/locale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: code }),
    }).catch(() => undefined)
    window.location.reload()
  }

  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={label}>
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => {
            void choose(code)
          }}
          aria-current={code === active ? 'true' : undefined}
          className={[
            'rounded px-2 py-1 text-xs font-medium transition-colors',
            code === active
              ? 'bg-card text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          ].join(' ')}
        >
          {LOCALE_META[code].label}
        </button>
      ))}
    </div>
  )
}

export default LanguageSwitcher
