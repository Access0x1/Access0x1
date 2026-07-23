/**
 * @file inference.ts — the AI inference provider seam (server-only).
 *
 * The one place a model call is made, abstracted behind a provider switch so the SAME route can
 * serve completions from Anthropic (default) OR from **0G Compute** — 0G's decentralized inference
 * network — by flipping `AI_INFERENCE_PROVIDER`. Deepens the 0G integration from "a chain we deploy
 * to" into "the AI backend our agent inference runs on," the AI-track story.
 *
 * PROVIDER SELECTION: `AI_INFERENCE_PROVIDER` = `anthropic` (default) | `zerog`. Each provider is
 * INDEPENDENTLY env-gated and fail-soft:
 *  - anthropic → `CLAUDE_API_KEY` (the existing seam).
 *  - zerog     → `ZEROG_COMPUTE_ENDPOINT` (an OpenAI-compatible 0G Compute inference URL) +
 *                `ZEROG_COMPUTE_API_KEY`. Absent ⇒ `isInferenceConfigured()` is false and the route
 *                returns `not_configured` (503) — never a crash, never a faked completion.
 *
 * Server-only (guardrail #4/#7): neither key ever reaches the browser. The 0G transport is the
 * injectable {@link FetchLike} seam so this module unit-tests offline against mocked JSON.
 *
 * @warn CONFIRM the 0G Compute endpoint shape (OpenAI-compatible `/chat/completions` assumed) and
 *   the broker/payment header against the 0G docs before mainnet use — marked assumed-until-confirmed.
 */

import type { FetchLike } from '../payout-swap/rails/uniswapTradingApi.js'

/** Which inference backend a completion is served from. */
export type InferenceProvider = 'anthropic' | 'zerog'

/** Why an inference could not be produced. */
export type InferenceFailure = 'not_configured' | 'invalid-args' | 'upstream_error'

/** Typed inference error. The message never contains a secret (guardrail #7). */
export class InferenceError extends Error {
  readonly reason: InferenceFailure
  constructor(reason: InferenceFailure, message: string) {
    super(message)
    this.name = 'InferenceError'
    this.reason = reason
  }
}

/** A single-prompt inference request (the shape the AI routes need). */
export interface InferenceRequest {
  /** The user prompt. */
  readonly prompt: string
  /** Model id override (defaults per provider). */
  readonly model?: string
  /** Max output tokens (default 512). */
  readonly maxTokens?: number
}

/** A normalized inference result, provider-agnostic. */
export interface InferenceResult {
  /** The backend that served it. */
  readonly provider: InferenceProvider
  /** The model id used. */
  readonly model: string
  /** The completion text. */
  readonly completion: string
}

const DEFAULT_MAX_TOKENS = 512
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5'
const DEFAULT_ZEROG_MODEL = 'llama-3.3-70b-instruct'

/** Read a trimmed env var ('' when unset). */
function env(name: string): string {
  return (process.env[name] ?? '').trim()
}

/**
 * The selected inference provider from `AI_INFERENCE_PROVIDER` (default `anthropic`). An
 * unrecognized value falls back to `anthropic` (fail-safe — the existing behavior).
 */
export function selectedProvider(): InferenceProvider {
  return env('AI_INFERENCE_PROVIDER').toLowerCase() === 'zerog' ? 'zerog' : 'anthropic'
}

/** Whether the SELECTED provider's env is present (what a `GET {configured}` probe reports). */
export function isInferenceConfigured(): boolean {
  return selectedProvider() === 'zerog'
    ? env('ZEROG_COMPUTE_ENDPOINT').length > 0 && env('ZEROG_COMPUTE_API_KEY').length > 0
    : env('CLAUDE_API_KEY').length > 0
}

/** Transport for the 0G Compute path (endpoint + key + fetch). */
export interface ZerogDeps {
  readonly endpoint: string
  readonly apiKey: string
  readonly fetchImpl: FetchLike
}

/** Build the 0G deps from env, or `undefined` when unconfigured (dormant). */
export function buildZerogDeps(): ZerogDeps | undefined {
  const endpoint = env('ZEROG_COMPUTE_ENDPOINT')
  const apiKey = env('ZEROG_COMPUTE_API_KEY')
  if (!endpoint || !apiKey) return undefined
  return { endpoint, apiKey, fetchImpl: (url, init) => fetch(url, init) }
}

/** The subset of an OpenAI-compatible `/chat/completions` response 0G Compute returns (assumed). */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[]
  model?: string
}

/**
 * Run one inference against 0G Compute (an OpenAI-compatible `/chat/completions` endpoint).
 * Injectable for tests. Throws {@link InferenceError} on a bad status or a response with no text.
 */
export async function runZerogInference(
  req: InferenceRequest,
  deps: ZerogDeps,
): Promise<InferenceResult> {
  const model = req.model ?? DEFAULT_ZEROG_MODEL
  const res = await deps.fetchImpl(`${deps.endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${deps.apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: req.prompt }],
    }),
  })
  if (!res.ok) {
    throw new InferenceError('upstream_error', `0G Compute inference failed (${res.status})`)
  }
  const body = (await res.json()) as ChatCompletionResponse
  const completion = body.choices?.[0]?.message?.content
  if (typeof completion !== 'string' || completion.length === 0) {
    throw new InferenceError('upstream_error', '0G Compute returned no completion text')
  }
  return { provider: 'zerog', model: body.model ?? model, completion }
}

/** Run one inference against Anthropic (the default provider). Throws {@link InferenceError}. */
async function runAnthropicInference(req: InferenceRequest): Promise<InferenceResult> {
  const apiKey = env('CLAUDE_API_KEY')
  if (!apiKey) throw new InferenceError('not_configured', 'CLAUDE_API_KEY is not set')
  const model = req.model ?? DEFAULT_ANTHROPIC_MODEL
  // Lazy import so the SDK is only loaded on the anthropic path (keeps the zerog path SDK-free).
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  try {
    const client = new Anthropic({ apiKey })
    const message = await client.messages.create({
      model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: req.prompt }],
    })
    const completion = message.content
      .map((b) => ('text' in b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('')
    return { provider: 'anthropic', model, completion }
  } catch (err) {
    throw new InferenceError('upstream_error', err instanceof Error ? err.message : 'anthropic error')
  }
}

/**
 * Run one inference against the SELECTED provider. Validates args fail-fast; throws
 * {@link InferenceError} with `not_configured` when the selected provider's env is absent, so the
 * route maps it to a 503 (never a crash). The `zerogDeps` param is injectable for tests; in
 * production it defaults to {@link buildZerogDeps}.
 */
export async function runInference(
  req: InferenceRequest,
  zerogDeps: ZerogDeps | undefined = buildZerogDeps(),
): Promise<InferenceResult> {
  if (typeof req.prompt !== 'string' || req.prompt.trim().length === 0) {
    throw new InferenceError('invalid-args', 'prompt must be a non-empty string')
  }
  if (selectedProvider() === 'zerog') {
    if (!zerogDeps) throw new InferenceError('not_configured', '0G Compute is not configured')
    return runZerogInference(req, zerogDeps)
  }
  return runAnthropicInference(req)
}
