'use client'

import { useState, type FormEvent, type ReactNode } from 'react'

/**
 * Collapsible "Ask Access0x1" widget. Posts a question to /api/ask (the
 * server-side Claude proxy) and renders the answer. The Claude key lives only
 * on the server; this component never sees it.
 */
export function AskAssistant(): ReactNode {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      const body = (await res.json()) as { answer?: string; error?: string }
      if (!res.ok || body.error) {
        setError(body.error ?? `Request failed (${res.status})`)
      } else {
        setAnswer(body.answer ?? '')
      }
    } catch {
      setError('Could not reach the assistant.')
    } finally {
      setLoading(false)
    }
  }

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
    </div>
  )
}
