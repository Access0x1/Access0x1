'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { JUDGE_BOT_TAGLINE } from '@/lib/judge/facts'

/**
 * AskView — the judge-facing Q&A chat UI for the /ask page.
 *
 * Renders an input + send button + a streamed answer area, styled to match the
 * rest of the app (white bg, --ax1-ink text, --ax1-rail indigo accent). It POSTs
 * the question to /api/ask and streams the text/plain response into the answer
 * area token-by-token.
 *
 * Fail-soft capability gate: /ask is a routable page, so unlike the floating
 * widget it cannot simply vanish — instead it probes GET /api/ask (the
 * server-side capability flag, the same env the POST handler checks) and, when
 * the assistant is NOT configured, disables the form and says so honestly in
 * the answer area. Never a dead form that errors on send. The probe fails OPEN
 * (a flaky probe must not blank a working page); the POST 503 path then flips
 * the view to the same honest unconfigured state, so even that race resolves
 * truthfully.
 *
 * Kept presentational + side-effect-light so it can be server-rendered to static
 * markup in tests (the FundButton / TokenPicker precedent), with the network calls
 * isolated to the mount probe and the submit handler.
 */

const SUGGESTIONS: readonly string[] = [
  'What is Access0x1?',
  'How does zero custody work?',
  'Can a refund ever be blocked?',
  'How are payments priced in USD?',
  'What did you build this weekend?',
]

/** What the deployment can do: probing, confirmed ready, or honestly off. */
export type AskCapability = 'checking' | 'ready' | 'unconfigured'

const NOT_CONFIGURED_MSG =
  'The assistant is not configured on this deployment — no server-side model key is set. ' +
  'Everything else on this site works without it.'

export function AskView({
  initialCapability = 'checking',
}: {
  /** Test/SSR seam only — the mount probe still corrects it in the browser. */
  initialCapability?: AskCapability
}): ReactNode {
  const [capability, setCapability] = useState<AskCapability>(initialCapability)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Guard against overlapping requests (double-submit / Enter spam).
  const inFlight = useRef(false)

  useEffect(() => {
    let cancelled = false
    void fetch('/api/ask')
      .then(async (res) => (res.ok ? ((await res.json()) as { configured?: boolean }) : null))
      .then((body) => {
        if (cancelled) return
        // Only an explicit "configured: false" disables the page; an
        // inconclusive probe fails open (see the component doc).
        setCapability(body?.configured === false ? 'unconfigured' : 'ready')
      })
      .catch(() => {
        if (!cancelled) setCapability('ready')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const ask = useCallback(async (q: string): Promise<void> => {
    const trimmed = q.trim()
    if (!trimmed || inFlight.current) return
    inFlight.current = true
    setLoading(true)
    setError(null)
    setAnswer('')

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      })

      if (!res.ok || !res.body) {
        // Read a JSON error body if present; otherwise a generic message.
        let msg = 'The assistant could not answer right now.'
        if (res.status === 503) {
          // Unconfigured: flip the whole view to the honest disabled state
          // (covers the probe-race and a key being pulled mid-session).
          setCapability('unconfigured')
          return
        }
        try {
          const body = (await res.json()) as { error?: string }
          if (body?.error) msg = body.error
        } catch {
          // non-JSON error body — keep the generic message.
        }
        setError(msg)
        return
      }

      // Stream the text/plain body into the answer area as it arrives.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        setAnswer((prev) => prev + decoder.decode(value, { stream: true }))
      }
    } catch {
      setError('The assistant could not answer right now.')
    } finally {
      setLoading(false)
      inFlight.current = false
    }
  }, [])

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>): void => {
      e.preventDefault()
      void ask(question)
    },
    [ask, question],
  )

  const unconfigured = capability === 'unconfigured'

  return (
    <main
      data-testid="ask-view"
      data-ask-capability={capability}
      className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10 sm:py-16"
    >
      <header className="flex flex-col gap-2">
        <span className="text-xs font-mono uppercase tracking-widest text-[var(--ax1-rail)]">
          AI assistant
        </span>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Ask Access0x1
        </h1>
        <p className="text-sm leading-relaxed text-neutral-600">{JUDGE_BOT_TAGLINE}</p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label="Ask a question">
        <label htmlFor="ask-input" className="sr-only">
          Your question about Access0x1
        </label>
        <textarea
          id="ask-input"
          name="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void ask(question)
            }
          }}
          rows={3}
          maxLength={2000}
          disabled={unconfigured}
          placeholder={
            unconfigured
              ? 'Unavailable on this deployment'
              : 'e.g. How does the net + fee == gross invariant work?'
          }
          className="w-full resize-y rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm leading-relaxed text-[var(--ax1-ink)] outline-none transition focus:border-[var(--ax1-rail)] focus:ring-2 focus:ring-[var(--ax1-rail)]/20 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-neutral-400">
            Grounded in the repo · testnet build · no mainnet claims
          </span>
          <button
            type="submit"
            disabled={loading || unconfigured || question.trim().length === 0}
            data-action="ask-send"
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--ax1-rail)] px-5 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </form>

      <div className="flex flex-wrap gap-2" aria-label="Suggested questions">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setQuestion(s)
              void ask(s)
            }}
            disabled={loading || unconfigured}
            className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 transition hover:border-[var(--ax1-rail)] hover:text-[var(--ax1-ink)] disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>

      <section
        data-testid="ask-answer"
        aria-live="polite"
        className="min-h-[8rem] rounded-2xl border border-neutral-200 bg-neutral-50 px-5 py-4 text-sm leading-relaxed text-[var(--ax1-ink)]"
      >
        {unconfigured ? (
          <p className="text-neutral-500">{NOT_CONFIGURED_MSG}</p>
        ) : error ? (
          <p className="text-[var(--destructive,#dc2626)]">{error}</p>
        ) : answer ? (
          <p className="whitespace-pre-wrap">{answer}</p>
        ) : (
          <p className="text-neutral-400">
            {loading ? 'Thinking…' : 'The answer will stream in here.'}
          </p>
        )}
      </section>

      <footer className="mt-auto pt-6 text-xs text-neutral-400">
        <a href="/onboard" className="underline transition hover:text-[var(--ax1-ink)]">
          ← Back to Access0x1
        </a>
      </footer>
    </main>
  )
}
