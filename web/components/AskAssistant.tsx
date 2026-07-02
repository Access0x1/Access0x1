'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

/**
 * Collapsible "Ask Access0x1" widget. Posts a question to /api/ask (the
 * server-side Claude proxy) and STREAMS the grounded answer in. The Claude key
 * lives only on the server; this component never sees it. For the full-page
 * booth experience it links out to /ask.
 *
 * Fail-soft capability gate: on mount the widget probes GET /api/ask (the
 * server-side capability flag — the same env the POST handler checks) and
 * renders NOTHING until the server confirms the assistant is configured. An
 * unconfigured deployment therefore never shows a dead button that errors on
 * click — the widget simply isn't there. If the probe itself fails, we stay
 * hidden: this widget is optional chrome, so absent beats broken.
 */
export function AskAssistant({
  initialConfigured = null,
}: {
  /** Test/SSR seam only — the mount probe still corrects it in the browser. */
  initialConfigured?: boolean | null
}): ReactNode {
  const [configured, setConfigured] = useState<boolean | null>(initialConfigured)
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetch('/api/ask')
      .then(async (res) => (res.ok ? ((await res.json()) as { configured?: boolean }) : null))
      .then((body) => {
        if (!cancelled) setConfigured(body?.configured === true)
      })
      .catch(() => {
        if (!cancelled) setConfigured(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const q = question.trim()
    if (!q) return
    setLoading(true)
    setError(null)
    setAnswer('')
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      if (!res.ok || !res.body) {
        // Error responses are JSON ({ error }); the success path streams text.
        let msg = `Request failed (${res.status})`
        if (res.status === 503) {
          msg = 'The assistant is not configured on this deployment yet.'
        } else {
          try {
            const body = (await res.json()) as { error?: string }
            if (body?.error) msg = body.error
          } catch {
            // non-JSON error body — keep the generic message.
          }
        }
        setError(msg)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        setAnswer((prev) => prev + decoder.decode(value, { stream: true }))
      }
    } catch {
      setError('Could not reach the assistant.')
    } finally {
      setLoading(false)
    }
  }

  // Not confirmed configured (unknown or explicitly off) ⇒ no widget at all.
  if (configured !== true) return null

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 rounded-full bg-ink px-4 py-2 text-sm text-white shadow-lg hover:opacity-90"
      >
        Ask Access0x1
      </button>
    )
  }

  return (
    <div className="fixed bottom-4 right-4 flex w-80 flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-xl">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">Ask Access0x1</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-neutral-400 hover:text-ink"
          aria-label="Close assistant"
        >
          ✕
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="How do I integrate Access0x1?"
          rows={3}
          className="resize-none rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-rail"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-rail px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {answer ? (
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-ink">{answer}</p>
      ) : null}

      <a
        href="/ask"
        className="text-xs text-neutral-400 underline-offset-2 hover:text-ink hover:underline"
      >
        Open the full assistant →
      </a>
    </div>
  )
}
