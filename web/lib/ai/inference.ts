/**
 * @file inference.ts — the AI inference provider seam (server-only).
 *
 * The one place a model call is made, abstracted behind a provider switch so the SAME route can
 * serve completions from Anthropic (default) OR from **0G Compute** — 0G's decentralized inference
 * network — WITHOUT the agent ever living on or deploying to the 0G chain. An Access0x1 agent is
 * born Ethereum-native (its identity is an ENS name + `SessionGrant`, its money is the USDC
 * router); "joining 0G" is a RUNTIME decision — flip {@link selectedProvider} globally, pass a
 * per-request `provider`, or let the agent's own ENS record decide (see `agentInference.ts`). The
 * only 0G touchpoint is a funded broker account the OPERATOR holds to pay per inference — never the
 * agent, never a redeploy.
 *
 * PROVIDER SELECTION: `AI_INFERENCE_PROVIDER` = `anthropic` (default) | `zerog`, overridable
 * per-request via {@link InferenceRequest.provider}. Each provider is INDEPENDENTLY env-gated and
 * fail-soft:
 *  - anthropic → `CLAUDE_API_KEY` (the existing seam).
 *  - zerog     → two modes:
 *      • **key mode** (simple gateway): `ZEROG_COMPUTE_ENDPOINT` (an OpenAI-compatible URL) +
 *        `ZEROG_COMPUTE_API_KEY`. A static Bearer key fronting a provider.
 *      • **broker mode** (native 0G Compute): `ZEROG_BROKER_PRIVATE_KEY` (a funded 0G wallet,
 *        SERVER-ONLY) + `ZEROG_PROVIDER_ADDRESS`. 0G has no static key — the broker mints
 *        SINGLE-USE, signed billing headers per request off the funded account (the settlement
 *        proof) and the request goes to the provider's OpenAI-compatible `/chat/completions`.
 *    Absent ⇒ `isInferenceConfigured()` is false and the route returns `not_configured` (503) —
 *    never a crash, never a faked completion.
 *
 * Server-only (guardrail #4/#7): neither key nor the broker private key ever reaches the browser.
 * The 0G transport (the {@link FetchLike} + the broker) is injectable so this module unit-tests
 * offline against a mocked broker and mocked JSON.
 *
 * @warn CONFIRM against the 0G docs before mainnet use — marked assumed-until-confirmed: the
 *   OpenAI-compatible `/chat/completions` shape, the `@0gfoundation/0g-compute-ts-sdk` broker
 *   method names (`getServiceMetadata` / `getRequestHeaders` / `processResponse`), and the funding
 *   flow. The SDK + `ethers` are LAZY-imported so this repo builds without them installed; broker
 *   mode stays dormant (fail-soft `undefined`) until the operator installs them and funds a wallet.
 */

import type { FetchLike } from '../payout-swap/rails/uniswapTradingApi.js'

/** Which inference backend a completion is served from. */
export type InferenceProvider = 'anthropic' | 'zerog'

/** How the 0G path authenticates: a static gateway key, or the native 0G broker. */
export type ZerogMode = 'key' | 'broker'

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
  /**
   * Per-request provider override — the "it can decide" hook. When set, this wins over the global
   * `AI_INFERENCE_PROVIDER`, so a single agent/call can route to 0G while the deployment default
   * stays Anthropic (e.g. resolved from the agent's ENS record — see `agentInference.ts`).
   */
  readonly provider?: InferenceProvider
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

/** The default 0G testnet EVM RPC (env-overridable) — where the broker settles inference fees. */
const DEFAULT_ZEROG_RPC_URL = 'https://evmrpc-testnet.0g.ai'

/** Read a trimmed env var ('' when unset). */
function env(name: string): string {
  return (process.env[name] ?? '').trim()
}

/**
 * The globally-selected inference provider from `AI_INFERENCE_PROVIDER` (default `anthropic`). An
 * unrecognized value falls back to `anthropic` (fail-safe — the existing behavior).
 */
export function selectedProvider(): InferenceProvider {
  return env('AI_INFERENCE_PROVIDER').toLowerCase() === 'zerog' ? 'zerog' : 'anthropic'
}

/**
 * The active 0G auth mode: `broker` when a broker private key is present (native 0G Compute),
 * else `key` (a static gateway key). `ZEROG_MODE` can force it explicitly.
 */
export function zerogMode(): ZerogMode {
  const forced = env('ZEROG_MODE').toLowerCase()
  if (forced === 'broker' || forced === 'key') return forced
  return env('ZEROG_BROKER_PRIVATE_KEY').length > 0 ? 'broker' : 'key'
}

/** Whether the 0G path's env is present for its active mode. */
function isZerogConfigured(): boolean {
  return zerogMode() === 'broker'
    ? env('ZEROG_BROKER_PRIVATE_KEY').length > 0 && env('ZEROG_PROVIDER_ADDRESS').length > 0
    : env('ZEROG_COMPUTE_ENDPOINT').length > 0 && env('ZEROG_COMPUTE_API_KEY').length > 0
}

/**
 * Whether the given provider's env is present (default: the globally-selected provider). This is
 * what a `GET {configured}` probe reports.
 */
export function isInferenceConfigured(provider: InferenceProvider = selectedProvider()): boolean {
  return provider === 'zerog' ? isZerogConfigured() : env('CLAUDE_API_KEY').length > 0
}

/**
 * Transport for the 0G Compute path. `authHeaders` is the pluggable auth: in key mode it is a
 * static Bearer header (built from `apiKey`); in broker mode it is the per-request signed billing
 * header the 0G broker mints. `onResponse` is the broker's post-inference settlement hook (a no-op
 * in key mode).
 */
export interface ZerogDeps {
  /** The provider's OpenAI-compatible base URL (no trailing `/chat/completions`). */
  readonly endpoint: string
  /** Static gateway key (key mode). Ignored when `authHeaders` is provided. */
  readonly apiKey?: string
  /** Model id from the provider metadata (broker mode); a request `model` still wins. */
  readonly model?: string
  /** Per-request auth headers. Overrides the static Bearer path when present (broker mode). */
  readonly authHeaders?: (content: string) => Promise<Record<string, string>> | Record<string, string>
  /** Post-response settlement hook (broker mode). Best-effort — never fails the returned answer. */
  readonly onResponse?: (content: string) => Promise<void>
  readonly fetchImpl: FetchLike
}

/**
 * Build the 0G KEY-mode deps from env, or `undefined` when unconfigured (dormant). This is the
 * simple "static Bearer key fronting an OpenAI-compatible endpoint" path.
 */
export function buildZerogDeps(): ZerogDeps | undefined {
  const endpoint = env('ZEROG_COMPUTE_ENDPOINT')
  const apiKey = env('ZEROG_COMPUTE_API_KEY')
  if (!endpoint || !apiKey) return undefined
  return { endpoint, apiKey, fetchImpl: (url, init) => fetch(url, init) }
}

/**
 * A minimal view of the 0G Compute broker (`@0gfoundation/0g-compute-ts-sdk`) this adapter needs.
 * Declared here so the adapter is unit-testable against a fake broker without the SDK installed.
 * @see https://github.com/0gfoundation/0g-compute-ts-sdk
 */
export interface ZerogBrokerLike {
  readonly inference: {
    /** Resolve the chosen provider's endpoint + model (`getServiceMetadata`). */
    getServiceMetadata(provider: string): Promise<{ endpoint: string; model: string }>
    /** Mint the single-use, signed billing headers for one request (`getRequestHeaders`). */
    getRequestHeaders(provider: string, content?: string): Promise<Record<string, string>>
    /** One-time provider acknowledgement before first use (`acknowledgeProviderSigner`). */
    acknowledgeProviderSigner?(provider: string): Promise<void>
    /** Settle/verify the response for billing (`processResponse`). */
    processResponse?(provider: string, content: string): Promise<void>
  }
}

/** How a real broker is constructed — injectable so tests never load the SDK. */
export type ZerogBrokerFactory = () => Promise<ZerogBrokerLike | undefined>

/** The tiny surface of `ethers` the default factory uses (declared locally — optional peer dep). */
interface EthersLike {
  JsonRpcProvider: new (url: string) => unknown
  Wallet: new (privateKey: string, provider: unknown) => unknown
}

/** The 0G SDK entry point the default factory uses (declared locally — optional peer dep). */
interface ZerogSdkLike {
  createZGComputeNetworkBroker: (signer: unknown) => Promise<ZerogBrokerLike>
}

/**
 * The default broker factory: LAZY-imports `ethers` + `@0gfoundation/0g-compute-ts-sdk`, builds a
 * wallet from `ZEROG_BROKER_PRIVATE_KEY` on `ZEROG_BROKER_RPC_URL` (default 0G testnet), and
 * returns the broker. Returns `undefined` (dormant, fail-soft) if the deps are not installed or the
 * key is absent — so the repo builds and the seam stays inert until the operator opts in.
 */
const defaultBrokerFactory: ZerogBrokerFactory = async () => {
  const privateKey = env('ZEROG_BROKER_PRIVATE_KEY')
  if (!privateKey) return undefined
  try {
    // Indirect specifiers: `ethers` and the 0G SDK are OPTIONAL peers not in this repo's
    // dependencies, so a variable import spec keeps the type checker from resolving (and failing
    // on) a module that may not be installed. At runtime a missing module rejects and we degrade
    // to dormant `undefined` in the catch below.
    const load = (spec: string): Promise<unknown> => import(/* @vite-ignore */ spec)
    const { ethers } = (await load('ethers')) as { ethers: EthersLike }
    const sdk = (await load('@0gfoundation/0g-compute-ts-sdk')) as ZerogSdkLike
    const rpcUrl = env('ZEROG_BROKER_RPC_URL') || DEFAULT_ZEROG_RPC_URL
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const wallet = new ethers.Wallet(privateKey, provider)
    return await sdk.createZGComputeNetworkBroker(wallet)
  } catch {
    // Not installed / bad key / network — stay dormant rather than crash the route.
    return undefined
  }
}

/**
 * Build the 0G BROKER-mode deps (native 0G Compute): acknowledge the provider, fetch its endpoint +
 * model, and wire per-request signed headers + the settlement hook. Injectable factory for tests.
 * Returns `undefined` (dormant) when `ZEROG_PROVIDER_ADDRESS` is unset or the broker can't be built.
 */
export async function buildZerogBrokerDeps(
  factory: ZerogBrokerFactory = defaultBrokerFactory,
): Promise<ZerogDeps | undefined> {
  const provider = env('ZEROG_PROVIDER_ADDRESS')
  if (!provider) return undefined
  const broker = await factory()
  if (!broker) return undefined

  // One-time acknowledgement is best-effort (idempotent on the 0G side); never block on it.
  try {
    await broker.inference.acknowledgeProviderSigner?.(provider)
  } catch {
    /* already acknowledged / transient — proceed to metadata */
  }

  const { endpoint, model } = await broker.inference.getServiceMetadata(provider)
  return {
    endpoint,
    model,
    fetchImpl: (url, init) => fetch(url, init),
    authHeaders: (content) => broker.inference.getRequestHeaders(provider, content),
    onResponse: async (content) => {
      try {
        await broker.inference.processResponse?.(provider, content)
      } catch {
        /* settlement is best-effort on testnet — the caller already has its answer */
      }
    },
  }
}

/** The subset of an OpenAI-compatible `/chat/completions` response 0G Compute returns (assumed). */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[]
  model?: string
}

/**
 * Run one inference against 0G Compute (an OpenAI-compatible `/chat/completions` endpoint), in
 * either key or broker mode depending on the {@link ZerogDeps} handed in. Injectable for tests.
 * Throws {@link InferenceError} on a bad status or a response with no text.
 */
export async function runZerogInference(
  req: InferenceRequest,
  deps: ZerogDeps,
): Promise<InferenceResult> {
  const model = req.model ?? deps.model ?? DEFAULT_ZEROG_MODEL
  const auth = deps.authHeaders
    ? await deps.authHeaders(req.prompt)
    : { Authorization: `Bearer ${deps.apiKey ?? ''}` }
  const res = await deps.fetchImpl(`${deps.endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
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
  // Broker settlement (no-op in key mode); best-effort, never rewrites the answer.
  if (deps.onResponse) await deps.onResponse(completion)
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

/** Sentinel: "resolve the 0G deps from env" (distinct from an explicit `undefined` = no deps). */
const RESOLVE_ZEROG_DEPS = Symbol('resolve-zerog-deps')

/** Resolve the 0G deps from env for the active mode (broker → key). */
async function resolveZerogDeps(): Promise<ZerogDeps | undefined> {
  return zerogMode() === 'broker' ? buildZerogBrokerDeps() : buildZerogDeps()
}

/**
 * Run one inference against the chosen provider — `req.provider` (the per-request decision) if set,
 * else the global {@link selectedProvider}. Validates args fail-fast; throws {@link InferenceError}
 * with `not_configured` when the chosen provider's env is absent, so the route maps it to a 503
 * (never a crash).
 *
 * `zerogDeps` is injectable for tests: omit it to resolve from env (key or broker mode); pass a
 * concrete deps object to force it; pass explicit `undefined` to assert the not-configured path.
 */
export async function runInference(
  req: InferenceRequest,
  zerogDeps: ZerogDeps | undefined | typeof RESOLVE_ZEROG_DEPS = RESOLVE_ZEROG_DEPS,
): Promise<InferenceResult> {
  if (typeof req.prompt !== 'string' || req.prompt.trim().length === 0) {
    throw new InferenceError('invalid-args', 'prompt must be a non-empty string')
  }
  const provider = req.provider ?? selectedProvider()
  if (provider === 'zerog') {
    const deps = zerogDeps === RESOLVE_ZEROG_DEPS ? await resolveZerogDeps() : zerogDeps
    if (!deps) throw new InferenceError('not_configured', '0G Compute is not configured')
    return runZerogInference(req, deps)
  }
  return runAnthropicInference(req)
}
