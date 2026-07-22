'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * DocsAssistant — the inline chatbox for the Access0x1 documentation assistant.
 *
 * A self-contained card that answers questions ONLY from the shipped docs/*.md
 * corpus (via POST /api/docs-ask), streaming the grounded, source-cited answer in
 * token-by-token. The model key lives only on the server; this component never
 * sees it.
 *
 * Fail-soft capability gate (the AskView pattern): on mount it probes GET
 * /api/docs-ask — the server-side capability flag, the same env the POST handler
 * checks — and, when the assistant is NOT configured, DISABLES the form and says
 * so honestly in the answer area rather than showing a dead control that errors on
 * send. The probe fails OPEN (a flaky probe must not disable a working page); the
 * POST 503 path then flips the view to the same honest unconfigured state, so even
 * that race resolves truthfully.
 *
 * Kept presentational + side-effect-light so it server-renders to static markup in
 * tests (the AskView precedent), with the network calls isolated to the mount probe
 * and the submit handler.
 */

/** What the deployment can do: probing, confirmed ready, or honestly off. */
export type DocsCapability = 'checking' | 'ready' | 'unconfigured'

const NOT_CONFIGURED_MSG =
  'The documentation assistant is not configured on this deployment — no server-side ' +
  'model key is set. The documentation itself is always available.'

/** Plain, docs-shaped starter questions (no marketing copy). */
const SUGGESTIONS: readonly string[] = [
  'How do I register a merchant?',
  'How is a payment priced in USD?',
  'Which testnets are supported?',
  'How is the platform fee split?',
  'Where should I start?',
]

export function DocsAssistant({
  initialCapability = 'checking',
}: {
  /** Test/SSR seam only — the mount probe still corrects it in the browser. */
  initialCapability?: DocsCapability
}): ReactNode {
  const [capability, setCapability] = useState<DocsCapability>(initialCapability)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Guard against overlapping requests (double-submit / Enter spam).
  const inFlight = useRef(false)

  useEffect(() => {
    let cancelled = false
    void fetch('/api/docs-ask')
      .then(async (res) => (res.ok ? ((await res.json()) as { configured?: boolean }) : null))
      .then((body) => {
        if (cancelled) return
        // Only an explicit "configured: false" disables the card; an
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
      const res = await fetch('/api/docs-ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      })

      if (!res.ok || !res.body) {
        let msg = 'The assistant could not answer right now.'
        if (res.status === 503) {
          // Unconfigured: flip the whole card to the honest disabled state
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
    <Card data-testid="docs-assistant" data-docs-capability={capability}>
      <CardHeader>
        <CardTitle>Ask the docs</CardTitle>
        <CardDescription>
          Answers come only from the Access0x1 documentation, with the source file cited.
          Testnet build.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label="Ask a documentation question">
          <label htmlFor="docs-input" className="sr-only">
            Your question about the Access0x1 documentation
          </label>
          <textarea
            id="docs-input"
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
              unconfigured ? 'Unavailable on this deployment' : 'e.g. How do I register a merchant?'
            }
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none transition focus:border-rail focus:ring-2 focus:ring-rail/20 disabled:cursor-not-allowed disabled:bg-secondary disabled:text-muted-foreground"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Grounded in the docs · source file cited · no mainnet claims
            </span>
            <Button
              type="submit"
              size="sm"
              data-action="docs-send"
              disabled={loading || unconfigured || question.trim().length === 0}
            >
              {loading ? 'Asking…' : 'Ask'}
            </Button>
          </div>
        </form>

        <div className="flex flex-wrap gap-2" aria-label="Suggested questions">
          {SUGGESTIONS.map((s) => (
            <Button
              key={s}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setQuestion(s)
                void ask(s)
              }}
              disabled={loading || unconfigured}
            >
              {s}
            </Button>
          ))}
        </div>

        <section
          data-testid="docs-answer"
          aria-live="polite"
          className="min-h-[8rem] rounded-md border border-border bg-secondary px-4 py-3 text-sm leading-relaxed text-foreground"
        >
          {unconfigured ? (
            <p className="text-muted-foreground">{NOT_CONFIGURED_MSG}</p>
          ) : error ? (
            <p className="text-destructive">{error}</p>
          ) : answer ? (
            <p className="whitespace-pre-wrap">{answer}</p>
          ) : (
            <p className="text-muted-foreground">
              {loading ? 'Thinking…' : 'The answer will stream in here.'}
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  )
}
