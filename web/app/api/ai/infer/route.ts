/**
 * /api/ai/infer — provider-switchable AI inference (Anthropic default | 0G Compute).
 *
 * A plain, env-gated inference endpoint that runs the completion through the selected provider
 * ({@link runInference}). Flip `AI_INFERENCE_PROVIDER=zerog` (+ `ZEROG_COMPUTE_*`) and the SAME
 * endpoint serves inference from **0G Compute** — 0G's decentralized inference network — instead of
 * Anthropic. This is the concrete "AI runs on 0G" surface.
 *
 *   GET  /api/ai/infer                 → { configured, provider } capability probe
 *   POST /api/ai/infer { prompt }      → { provider, model, completion }
 *
 * FAIL-SOFT (law #4): the selected provider being unconfigured returns 503 `not_configured` (the UI
 * probe hides the affordance), a bad body is 400, an upstream failure is 502 — never a 500 crash and
 * never a faked completion. Server-only: neither provider key reaches the browser.
 */

import { isInferenceConfigured, runInference, selectedProvider, InferenceError } from '@/lib/ai/inference'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_PROMPT_LEN = 4000

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** Capability probe — reveals only whether the selected provider is configured (never a key). */
export async function GET(): Promise<Response> {
  return json({ configured: isInferenceConfigured(), provider: selectedProvider() })
}

export async function POST(request: Request): Promise<Response> {
  if (!isInferenceConfigured()) {
    return json(
      { error: 'AI inference is not configured on this deployment.', code: 'not_configured' },
      503,
    )
  }

  let body: { prompt?: unknown; model?: unknown; maxTokens?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: 'invalid_json', code: 'invalid-args' }, 400)
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  if (prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LEN) {
    return json({ error: `prompt must be 1..${MAX_PROMPT_LEN} chars`, code: 'invalid-args' }, 400)
  }

  try {
    const result = await runInference({
      prompt,
      model: typeof body.model === 'string' ? body.model : undefined,
      maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
    })
    return json(result, 200)
  } catch (err) {
    if (err instanceof InferenceError) {
      const status = err.reason === 'not_configured' ? 503 : err.reason === 'invalid-args' ? 400 : 502
      return json({ error: err.message, code: err.reason }, status)
    }
    return json({ error: 'inference failed', code: 'upstream_error' }, 502)
  }
}
