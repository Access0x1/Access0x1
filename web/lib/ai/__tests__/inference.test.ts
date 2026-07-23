/**
 * @file inference.test.ts — the AI inference provider seam (Anthropic | 0G Compute).
 *
 * Pins provider selection, per-provider env gating, the 0G Compute request shaping + response
 * mapping, and runInference's fail-fast / not_configured dispatch — the 0G path fully mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildZerogDeps,
  InferenceError,
  isInferenceConfigured,
  runInference,
  runZerogInference,
  selectedProvider,
  type ZerogDeps,
} from '../inference.js'
import type { FetchLike } from '../../payout-swap/rails/uniswapTradingApi.js'

const ENV_KEYS = ['AI_INFERENCE_PROVIDER', 'CLAUDE_API_KEY', 'ZEROG_COMPUTE_ENDPOINT', 'ZEROG_COMPUTE_API_KEY']
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function zerogDeps(fetchImpl: ZerogDeps['fetchImpl']): ZerogDeps {
  return { endpoint: 'https://compute.0g', apiKey: 'k', fetchImpl }
}

describe('selectedProvider + gating', () => {
  it('defaults to anthropic, honors AI_INFERENCE_PROVIDER=zerog', () => {
    expect(selectedProvider()).toBe('anthropic')
    process.env.AI_INFERENCE_PROVIDER = 'zerog'
    expect(selectedProvider()).toBe('zerog')
  })

  it('anthropic configured iff CLAUDE_API_KEY set', () => {
    expect(isInferenceConfigured()).toBe(false)
    process.env.CLAUDE_API_KEY = 'sk'
    expect(isInferenceConfigured()).toBe(true)
  })

  it('zerog configured iff BOTH endpoint and key set', () => {
    process.env.AI_INFERENCE_PROVIDER = 'zerog'
    expect(isInferenceConfigured()).toBe(false)
    process.env.ZEROG_COMPUTE_ENDPOINT = 'https://compute.0g'
    expect(isInferenceConfigured()).toBe(false)
    process.env.ZEROG_COMPUTE_API_KEY = 'k'
    expect(isInferenceConfigured()).toBe(true)
    expect(buildZerogDeps()?.endpoint).toBe('https://compute.0g')
  })
})

describe('runZerogInference', () => {
  it('maps choices[0].message.content and sends the OpenAI-compatible body', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ model: 'llama-x', choices: [{ message: { content: 'hi there' } }] }))
    const res = await runZerogInference({ prompt: 'hello', maxTokens: 128 }, zerogDeps(fetchImpl))
    expect(res).toEqual({ provider: 'zerog', model: 'llama-x', completion: 'hi there' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://compute.0g/chat/completions')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(body.max_tokens).toBe(128)
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer k' })
  })

  it('throws upstream_error on a non-2xx status', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ error: 'x' }, 500))
    await expect(runZerogInference({ prompt: 'hi' }, zerogDeps(fetchImpl))).rejects.toMatchObject({
      reason: 'upstream_error',
    })
  })

  it('throws upstream_error when the response has no completion text', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ choices: [] }))
    await expect(runZerogInference({ prompt: 'hi' }, zerogDeps(fetchImpl))).rejects.toBeInstanceOf(InferenceError)
  })
})

describe('runInference dispatch', () => {
  it('rejects an empty prompt fail-fast (invalid-args)', async () => {
    await expect(runInference({ prompt: '   ' })).rejects.toMatchObject({ reason: 'invalid-args' })
  })

  it('throws not_configured when zerog is selected but no deps', async () => {
    process.env.AI_INFERENCE_PROVIDER = 'zerog'
    await expect(runInference({ prompt: 'hi' }, undefined)).rejects.toMatchObject({ reason: 'not_configured' })
  })

  it('dispatches to 0G with injected deps', async () => {
    process.env.AI_INFERENCE_PROVIDER = 'zerog'
    const fetchImpl = vi.fn<FetchLike>(async () => json({ choices: [{ message: { content: 'ok' } }] }))
    const res = await runInference({ prompt: 'hi' }, zerogDeps(fetchImpl))
    expect(res.provider).toBe('zerog')
    expect(res.completion).toBe('ok')
  })
})
