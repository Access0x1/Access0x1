/**
 * /api/ens/agent — issue (or re-issue) an AGENT subname `agent-<id16>.<PARENT>.eth` and PUBLISH the
 * agent's identity + its inference choice into ENS text records, gaslessly via Namestone.
 *
 * This is the write half of the "an Ethereum-native agent decides to join 0G" loop: the agent (or
 * its owner) publishes `click.access0x1.inference = zerog` onto its OWN ENS name here, and
 * `lib/ai/agentInference.ts` (`resolveAgentInferenceProvider`) reads the SAME key back at inference
 * time. The agent never touches the 0G chain — the decision lives in its Ethereum identity.
 *
 * POST /api/ens/agent
 *   body: {
 *     owner: "0x…",                       // the granting principal (the auth tenant)
 *     delegate: "0x…",                    // the agent address (becomes the name's addr record)
 *     registry: { chainId: 1, address: "0x…" },  // the agent registry (explicit — no default)
 *     inferenceProvider?: "zerog" | "anthropic", // publishes click.access0x1.inference
 *     displayName?: "…",                  // optional → nameHash commitment only (never plaintext)
 *     discovery?: { context?: "…", endpoints?: { a2a: "…" } }  // optional ENSIP-26 records
 *   }
 *
 * The identity (agentId, nameHash) is DERIVED SERVER-SIDE from (owner, delegate) — the client can't
 * forge an agentId that doesn't match its owner/delegate. PARENT + Namestone key are read server-
 * side in `lib/ens-subnames.ts` (never hardcoded, never echoed).
 *
 * FAIL-SOFT (law #4): unconfigured seam ⇒ 503 not_configured NO-OP (no network, no fake name); bad
 * body ⇒ 400; upstream Namestone failure ⇒ 502. Writes only identity/discovery/inference records —
 * no money, no key, no payout ever passes through here.
 */

import { NextResponse } from 'next/server'
import { buildAgentIdentity } from '@/lib/agent/identity'
import { issueAgentSubname, type AgentDiscovery } from '@/lib/agent/agentSubname'
import type { AgentRegistry } from '@/lib/agent/ensIdentity'
import type { InferenceProvider } from '@/lib/ai/inference'
import { resolveVerifiedTenantForWrite, TenantAuthError } from '@/lib/branding/tenant'

export const dynamic = 'force-dynamic'

/** Map a subname-issue error code to an HTTP status (no secret ever leaks). */
function statusForCode(code: 'not_configured' | 'bad_input' | 'namestone_error'): number {
  switch (code) {
    case 'not_configured':
      return 503 // seam OFF (no key / no parent) — fail-soft, did nothing
    case 'bad_input':
      return 400 // missing/invalid identity or registry — never issue against a guess
    default:
      return 502 // upstream Namestone error — transient, not a forge
  }
}

/** Narrow an untrusted value to a known InferenceProvider, or undefined (⇒ no record written). */
function parseProvider(value: unknown): InferenceProvider | undefined {
  return value === 'zerog' || value === 'anthropic' ? value : undefined
}

/** Narrow an untrusted registry object; returns null when malformed (⇒ bad_input). */
function parseRegistry(value: unknown): AgentRegistry | null {
  if (!value || typeof value !== 'object') return null
  const chainId = (value as { chainId?: unknown }).chainId
  const address = (value as { address?: unknown }).address
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) return null
  if (typeof address !== 'string' || address.length === 0) return null
  return { chainId, address }
}

/** Narrow the optional ENSIP-26 discovery bag (context + endpoints), dropping non-strings. */
function parseDiscovery(value: unknown): Pick<AgentDiscovery, 'context' | 'endpoints'> {
  if (!value || typeof value !== 'object') return {}
  const out: Pick<AgentDiscovery, 'context' | 'endpoints'> = {}
  const context = (value as { context?: unknown }).context
  if (typeof context === 'string') out.context = context
  const endpoints = (value as { endpoints?: unknown }).endpoints
  if (endpoints && typeof endpoints === 'object') {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(endpoints as Record<string, unknown>)) {
      if (typeof v === 'string') clean[k] = v
    }
    out.endpoints = clean
  }
  return out
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const owner = typeof body.owner === 'string' ? body.owner : ''
  const delegate = typeof body.delegate === 'string' ? body.delegate : ''

  // AUTH GATE (mirrors /api/ens/subname): this route signs records with the operator's Namestone key
  // under the trusted ENS parent. The agent identity is derived from `owner`, so the caller must
  // PROVE they control that wallet — else anyone could forge an agent binding / ENSIP-25 attestation
  // for someone else's principal. Unverified callers fail CLOSED in production.
  try {
    await resolveVerifiedTenantForWrite(request, { ...body, tenantId: owner })
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 })
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const registry = parseRegistry(body.registry)
  if (!registry) {
    return NextResponse.json({ error: 'missing_or_invalid_registry', code: 'bad_input' }, { status: 400 })
  }

  // Derive the identity SERVER-SIDE (agentId = keccak(owner, delegate); nameHash = commitment).
  // A malformed owner/delegate throws inside buildAgentIdentity ⇒ surfaced as bad_input, never a
  // guessed address.
  let identity
  try {
    identity = buildAgentIdentity({
      owner,
      delegate,
      displayName: typeof body.displayName === 'string' ? body.displayName : null,
    })
  } catch {
    return NextResponse.json({ error: 'invalid_owner_or_delegate', code: 'bad_input' }, { status: 400 })
  }

  const discovery: AgentDiscovery = {
    ...parseDiscovery(body.discovery),
    inferenceProvider: parseProvider(body.inferenceProvider),
  }

  const result = await issueAgentSubname({ identity, registry, discovery })
  if (!result.ok) {
    return NextResponse.json({ error: result.code, code: result.code }, { status: statusForCode(result.code) })
  }
  return NextResponse.json(
    { name: result.name, agentId: identity.agentId, inferenceProvider: discovery.inferenceProvider ?? null },
    { status: 200 },
  )
}
