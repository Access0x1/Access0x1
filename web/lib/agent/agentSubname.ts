/**
 * @file agentSubname.ts — the WRITE seam that binds an AGENT identity to a real ENS subname.
 *
 * `identity.ts` derives the deterministic agent record; `ensIdentity.ts` builds the ENSIP-25/26
 * keys and VERIFIES a claimed binding (read-only by doctrine). What neither does is ISSUE the
 * name — mint `agent-<id>.<PARENT>.eth` so the binding `verifyAgentBinding` checks for actually
 * exists on a resolvable name. This module closes that gap the same way merchants get theirs:
 * through the gasless Namestone seam in `lib/ens-subnames.ts`, keeping the READ module pure.
 *
 * What the issued subname carries (so BOTH legs of `verifyAgentBinding` can pass):
 *  1. addr: the subname resolves to the agent's DELEGATE address — leg 1 (name → delegate).
 *  2. the ENSIP-25 attestation record `agent-registration[<erc7930-registry>][<agentId>]` = "1"
 *     — leg 2 (the name owner attests the registry binding).
 *  3. optional ENSIP-26 discovery records: `agent-context` and `agent-endpoint[<protocol>]`.
 *  4. `com.access0x1.*` provenance records (full agentId, the granting owner, the name-hash
 *     COMMITMENT when present) — same generic namespace the merchant subnames use.
 *
 * Doctrine (inherited, both sides):
 *  - FAIL-SOFT like every optional seam: unconfigured (no NAMESTONE_API_KEY / ENS_SUBNAME_PARENT)
 *    ⇒ clean `{ ok:false, code:'not_configured' }` NO-OP — never throws, never invents a name,
 *    never calls the network. This module touches no money and holds no key.
 *  - NEVER builds a wrong key: ENSIP-25/26 construction THROWS on reserved `[`/`]` input inside
 *    `ensIdentity.ts`; here that surfaces as a visible `bad_input` result (the seam's no-throw
 *    contract), never a silently mangled record.
 *  - No hidden registry default: the registry is an explicit argument, mirroring `ensIdentity.ts`.
 */

import type { SubnameIssueResult, SubnameText } from '../ens-subnames'
import { isSubnameIssuanceConfigured, issueSubname } from '../ens-subnames'
import type { AgentIdentity } from './identity'
import type { AgentRegistry } from './ensIdentity'
import { AGENT_CONTEXT_KEY, agentEndpointKey, expectedAgentRegistration } from './ensIdentity'

/**
 * Generic TEXT-record keys for agent provenance on the subname — the agent-side
 * companion to `SUBNAME_TEXT_KEYS` (merchants), same `com.access0x1.*` namespace.
 */
export const AGENT_SUBNAME_TEXT_KEYS = {
  /** The full bytes32 agentId (the label carries only a 16-hex-char prefix of it). */
  agentId: 'com.access0x1.agentId',
  /** The granting principal — the account that delegated authority to the agent. */
  agentOwner: 'com.access0x1.agentOwner',
  /** The agent's display-name COMMITMENT (keccak256), when the caller named it. */
  agentNameHash: 'com.access0x1.agentNameHash',
} as const

/** How many hex chars of the agentId go into the label (64 bits — see below). */
const LABEL_ID_HEX_CHARS = 16

/**
 * The deterministic ENS label for an agent: `agent-<first 16 hex chars of agentId>`.
 *
 * Why a prefix and not the full hash: an ENS label caps at 63 chars and `agent-` +
 * 64 hex chars is 70. 16 hex chars (64 bits) keeps the label short and readable while
 * making an accidental collision unrealistic at any plausible number of agents; the FULL
 * agentId is still on the name twice over — in the `com.access0x1.agentId` record and
 * inside the ENSIP-25 key — so the label is a handle, never the identity itself.
 *
 * @param identity - the agent identity (its `agentId` seeds the label).
 * @returns the lowercase `agent-<16hex>` label, valid under the ENS label charset.
 */
export function agentSubnameLabel(identity: AgentIdentity): string {
  return `agent-${identity.agentId.slice(2, 2 + LABEL_ID_HEX_CHARS).toLowerCase()}`
}

/** Optional ENSIP-26 discovery inputs for {@link issueAgentSubname}. */
export interface AgentDiscovery {
  /** The `agent-context` entry-point value (e.g. a card/manifest URL). */
  context?: string
  /** `agent-endpoint[<protocol>]` values keyed by protocol (e.g. `{ mcp: url, a2a: url }`). */
  endpoints?: Record<string, string>
}

/**
 * Build the full ENS text-record set for an agent subname — PURE, no network:
 * the ENSIP-25 attestation, any ENSIP-26 discovery records, and the
 * `com.access0x1.*` provenance keys. Exported separately so a caller who issues
 * through another writer (or an owner setting records manually) gets the exact
 * same record set the seam would write.
 *
 * @param identity - the agent identity being bound.
 * @param registry - the registry the agent is registered in (explicit, never defaulted).
 * @param discovery - optional ENSIP-26 context/endpoint values; blank values are skipped.
 * @returns the ordered text-record list.
 * @throws if a discovery protocol key carries the reserved `[`/`]` characters
 *         (ENSIP-26 law — throw, never build a wrong key).
 */
export function agentSubnameTexts(
  identity: AgentIdentity,
  registry: AgentRegistry,
  discovery?: AgentDiscovery,
): SubnameText[] {
  // ENSIP-25 first: the attestation IS the binding; everything else is discovery.
  const attestation = expectedAgentRegistration(identity, registry)
  const texts: SubnameText[] = [
    { key: attestation.key, value: attestation.value },
    { key: AGENT_SUBNAME_TEXT_KEYS.agentId, value: identity.agentId },
    { key: AGENT_SUBNAME_TEXT_KEYS.agentOwner, value: identity.owner },
  ]
  if (identity.nameHash) {
    texts.push({ key: AGENT_SUBNAME_TEXT_KEYS.agentNameHash, value: identity.nameHash })
  }
  const context = (discovery?.context ?? '').trim()
  if (context.length > 0) {
    texts.push({ key: AGENT_CONTEXT_KEY, value: context })
  }
  for (const [protocol, endpoint] of Object.entries(discovery?.endpoints ?? {})) {
    const value = (endpoint ?? '').trim()
    if (value.length === 0) continue
    // agentEndpointKey throws on reserved brackets — the caller sees bad_input
    // via issueAgentSubname, or the raw throw when calling this pure builder.
    texts.push({ key: agentEndpointKey(protocol), value })
  }
  return texts
}

/**
 * Issue `agent-<id16>.<PARENT>.eth` for an agent — resolving to the DELEGATE address and
 * carrying the ENSIP-25 attestation + ENSIP-26 discovery + provenance records — via the
 * gasless Namestone seam. After a successful issue (and gateway propagation), the existing
 * `verifyAgentBinding(name, identity, registry, chainId)` passes both legs against this name.
 *
 * Inherits the seam's full fail-soft contract: unconfigured ⇒ `not_configured` NO-OP with no
 * network call; a reserved-character protocol key ⇒ `bad_input` (surfaced, never mangled);
 * upstream failure ⇒ `namestone_error`. Never throws.
 *
 * @param params.identity - the agent identity to bind (delegate becomes the addr record).
 * @param params.registry - the agent registry (explicit — e.g. `ERC8004_MAINNET_REGISTRY`).
 * @param params.discovery - optional ENSIP-26 context/endpoints.
 * @returns the issued name or a machine error code (never a throw).
 */
export async function issueAgentSubname(params: {
  identity: AgentIdentity
  registry: AgentRegistry
  discovery?: AgentDiscovery
}): Promise<SubnameIssueResult> {
  // Fail-soft mirror (defense-in-depth; issueSubname re-checks) so an unconfigured
  // seam never even constructs keys.
  if (!isSubnameIssuanceConfigured()) {
    return { ok: false, code: 'not_configured' }
  }

  let texts: SubnameText[]
  try {
    texts = agentSubnameTexts(params.identity, params.registry, params.discovery)
  } catch {
    // Reserved-bracket protocol (or malformed registry address): the key builders
    // throw by law; the seam's contract is a visible machine code, not a throw.
    return { ok: false, code: 'bad_input' }
  }

  return issueSubname({
    label: agentSubnameLabel(params.identity),
    owner: params.identity.delegate,
    texts,
  })
}
