/**
 * @file inference.test.ts — the AI inference provider seam (Anthropic | 0G Compute).
 *
 * Pins provider selection, per-provider env gating, the 0G Compute request shaping + response
 * mapping, and runInference's fail-fast / not_configured dispatch — the 0G path fully mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCustomDeps,
  buildHostedDeps,
  buildZerogBrokerDeps,
  buildZerogDeps,
  InferenceError,
  isInferenceConfigured,
  runInference,
  runZerogInference,
  selectedProvider,
  zerogMode,
  type ZerogBrokerLike,
  type ZerogDeps,
} from '../inference.js'
import type { FetchLike } from '../../payout-swap/rails/uniswapTradingApi.js'

const ENV_KEYS = [
  'AI_INFERENCE_PROVIDER',
  'CLAUDE_API_KEY',
  'ZEROG_COMPUTE_ENDPOINT',
  'ZEROG_COMPUTE_API_KEY',
  'ZEROG_MODE',
  'ZEROG_BROKER_PRIVATE_KEY',
  'ZEROG_PROVIDER_ADDRESS',
  'ZEROG_BROKER_RPC_URL',
  'ACCESS0X1_COMPUTE_ENDPOINT',
  'ACCESS0X1_COMPUTE_API_KEY',
  'ACCESS0X1_COMPUTE_MODEL',
  'CUSTOM_COMPUTE_ENDPOINT',
  'CUSTOM_COMPUTE_API_KEY',
  'CUSTOM_COMPUTE_MODEL',
]
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

  it('honors a per-request provider override (agent decides to join 0G)', async () => {
    // Global default stays anthropic; the single request opts into 0G.
    expect(selectedProvider()).toBe('anthropic')
    const fetchImpl = vi.fn<FetchLike>(async () => json({ choices: [{ message: { content: 'via-record' } }] }))
    const res = await runInference({ prompt: 'hi', provider: 'zerog' }, zerogDeps(fetchImpl))
    expect(res.provider).toBe('zerog')
    expect(res.completion).toBe('via-record')
  })
})

describe('access0x1 (hosted) provider', () => {
  it('selects via AI_INFERENCE_PROVIDER=access0x1 and gates on the endpoint alone', () => {
    process.env.AI_INFERENCE_PROVIDER = 'access0x1'
    expect(selectedProvider()).toBe('access0x1')
    expect(isInferenceConfigured()).toBe(false)
    process.env.ACCESS0X1_COMPUTE_ENDPOINT = 'https://api.access0x1.example'
    expect(isInferenceConfigured()).toBe(true) // key is optional on our own endpoint
    expect(buildHostedDeps()?.endpoint).toBe('https://api.access0x1.example')
  })

  it('dispatches to the hosted endpoint; Bearer only when a key is set; env model wins default', async () => {
    process.env.ACCESS0X1_COMPUTE_ENDPOINT = 'https://api.access0x1.example'
    process.env.ACCESS0X1_COMPUTE_MODEL = 'access0x1-serve-1'
    const fetchImpl = vi.fn<FetchLike>(async () => json({ choices: [{ message: { content: 'hosted-answer' } }] }))
    const deps = { ...buildHostedDeps()!, fetchImpl }
    const res = await runInference({ prompt: 'hi', provider: 'access0x1' }, deps)
    expect(res.provider).toBe('access0x1')
    expect(res.completion).toBe('hosted-answer')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://api.access0x1.example/chat/completions')
    const sent = (init as RequestInit).headers as Record<string, string>
    expect(sent.Authorization).toBeUndefined() // no key configured ⇒ no header
    expect(JSON.parse((init as RequestInit).body as string).model).toBe('access0x1-serve-1')
  })

  it('throws not_configured when selected but no endpoint is set', async () => {
    process.env.AI_INFERENCE_PROVIDER = 'access0x1'
    await expect(runInference({ prompt: 'hi' }, undefined)).rejects.toMatchObject({
      reason: 'not_configured',
    })
  })
})

describe('custom (any-vendor) provider — no lock-in', () => {
  it('any OpenAI-compatible endpoint works via CUSTOM_COMPUTE_*, with Bearer when a key is set', async () => {
    process.env.AI_INFERENCE_PROVIDER = 'custom'
    expect(isInferenceConfigured()).toBe(false)
    process.env.CUSTOM_COMPUTE_ENDPOINT = 'https://api.groq.example/openai/v1'
    process.env.CUSTOM_COMPUTE_API_KEY = 'gk'
    process.env.CUSTOM_COMPUTE_MODEL = 'mixtral-8x7b'
    expect(selectedProvider()).toBe('custom')
    expect(isInferenceConfigured()).toBe(true)

    const fetchImpl = vi.fn<FetchLike>(async () => json({ choices: [{ message: { content: 'vendor-free' } }] }))
    const deps = { ...buildCustomDeps()!, fetchImpl }
    const res = await runInference({ prompt: 'hi' }, deps)
    expect(res).toMatchObject({ provider: 'custom', completion: 'vendor-free' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://api.groq.example/openai/v1/chat/completions')
    const sent = (init as RequestInit).headers as Record<string, string>
    expect(sent.Authorization).toBe('Bearer gk')
    expect(JSON.parse((init as RequestInit).body as string).model).toBe('mixtral-8x7b')
  })

  it('throws not_configured when selected with no endpoint', async () => {
    process.env.AI_INFERENCE_PROVIDER = 'custom'
    await expect(runInference({ prompt: 'hi' }, undefined)).rejects.toMatchObject({
      reason: 'not_configured',
    })
  })
})

describe('zerogMode + broker gating', () => {
  it('is key mode by default, broker mode when a broker key is present, ZEROG_MODE forces it', () => {
    process.env.AI_INFERENCE_PROVIDER = 'zerog'
    expect(zerogMode()).toBe('key')
    process.env.ZEROG_BROKER_PRIVATE_KEY = '0xabc'
    expect(zerogMode()).toBe('broker')
    process.env.ZEROG_MODE = 'key'
    expect(zerogMode()).toBe('key') // explicit override wins
  })

  it('broker mode is configured iff BOTH broker key and provider address are set', () => {
    process.env.AI_INFERENCE_PROVIDER = 'zerog'
    process.env.ZEROG_BROKER_PRIVATE_KEY = '0xabc'
    expect(isInferenceConfigured()).toBe(false) // no provider yet
    process.env.ZEROG_PROVIDER_ADDRESS = '0xprovider'
    expect(isInferenceConfigured()).toBe(true)
    // A static compute key does NOT satisfy broker mode.
    delete process.env.ZEROG_PROVIDER_ADDRESS
    process.env.ZEROG_COMPUTE_ENDPOINT = 'https://compute.0g'
    process.env.ZEROG_COMPUTE_API_KEY = 'k'
    expect(isInferenceConfigured()).toBe(false)
  })
})

describe('buildZerogBrokerDeps', () => {
  function fakeBroker(over: Partial<ZerogBrokerLike['inference']> = {}): ZerogBrokerLike {
    return {
      inference: {
        getServiceMetadata: async () => ({ endpoint: 'https://provider.0g', model: 'llama-x' }),
        getRequestHeaders: async () => ({ 'x-0g-signature': 'sig', 'x-0g-fee': '100' }),
        acknowledgeProviderSigner: async () => {},
        processResponse: async () => null,
        ...over,
      },
    }
  }

  it('returns undefined (dormant) when no provider address is set', async () => {
    const deps = await buildZerogBrokerDeps(async () => fakeBroker())
    expect(deps).toBeUndefined()
  })

  it('returns undefined when the broker factory yields nothing (SDK absent)', async () => {
    process.env.ZEROG_PROVIDER_ADDRESS = '0xprovider'
    const deps = await buildZerogBrokerDeps(async () => undefined)
    expect(deps).toBeUndefined()
  })

  it('wires broker-signed headers + endpoint/model from metadata, and settlement runs', async () => {
    process.env.ZEROG_PROVIDER_ADDRESS = '0xprovider'
    const processResponse = vi.fn(async () => null)
    const deps = await buildZerogBrokerDeps(async () => fakeBroker({ processResponse }))
    expect(deps?.endpoint).toBe('https://provider.0g')
    expect(deps?.model).toBe('llama-x')

    // The deps carry per-request signed headers instead of a static Bearer key...
    const auth = await deps!.authHeaders!('hello')
    expect(auth).toMatchObject({ 'x-0g-signature': 'sig' })

    // ...and running an inference through them settles via processResponse.
    const fetchImpl = vi.fn<FetchLike>(async () =>
      json({ model: 'llama-x', choices: [{ message: { content: 'done' } }] }),
    )
    const res = await runZerogInference({ prompt: 'hi' }, { ...deps!, fetchImpl })
    expect(res.completion).toBe('done')
    const sent = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(sent).toMatchObject({ 'x-0g-signature': 'sig' })
    expect(sent.Authorization).toBeUndefined() // no static key on the broker path
    expect(processResponse).toHaveBeenCalledTimes(1)
  })

  it('a settlement error never fails the answer the caller already has', async () => {
    process.env.ZEROG_PROVIDER_ADDRESS = '0xprovider'
    const deps = await buildZerogBrokerDeps(async () =>
      fakeBroker({ processResponse: async () => { throw new Error('settle boom') } }),
    )
    const fetchImpl = vi.fn<FetchLike>(async () => json({ choices: [{ message: { content: 'ok' } }] }))
    const res = await runZerogInference({ prompt: 'hi' }, { ...deps!, fetchImpl })
    expect(res.completion).toBe('ok')
  })
})
