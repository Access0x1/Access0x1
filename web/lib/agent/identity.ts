/**
 * @file identity.ts — a deterministic, named AGENT identity record.
 *
 * An agent acting under a SessionGrant has, until now, been identified only by its
 * delegate ADDRESS. This module gives the agent a stable, deterministic IDENTITY —
 * an `agentId` derived from (owner, delegate) — plus a human DISPLAY NAME that is
 * committed exactly the way a merchant's business name is: the plaintext stays
 * client-side and ONLY a `nameHash = keccak256(name)` is ever surfaced for an
 * on-chain / on-the-wire commitment (mirroring `RegisterForm` + `branding/store`).
 *
 * WHY (owner, delegate) and not the on-chain sessionId: a session is short-lived
 * (it carries a nonce + expiry and dies); the AGENT — "this owner delegated to this
 * spender" — is the durable principal that may open many sessions over time. So the
 * agent's stable key is `keccak256(abi.encode(owner, delegate))`, the same encoding
 * the contract uses for its ids (non-packed `abi.encode`, address legs), minus the
 * nonce. It is deterministic: the same (owner, delegate) always yields the same id,
 * so a verification recorded against it (see `verification/store`) is durably
 * re-derivable from the two addresses alone.
 *
 * Doctrine:
 *  - PURE + deterministic: every export is a pure transform of its inputs. No env,
 *    no network, no I/O, no money. Safe to unit-test in isolation.
 *  - law #4 (truth in copy): the on-the-wire record carries ONLY the `nameHash`
 *    commitment, never an asserted plaintext name we cannot prove. The plaintext is
 *    held by the caller (client-side) exactly like the merchant business name.
 *  - It NEVER invents an address: a malformed owner/delegate THROWS rather than
 *    silently coercing to a zero address.
 */

import { encodeAbiParameters, getAddress, keccak256, toHex, type Hex } from 'viem'

/**
 * A deterministic, named agent identity.
 *
 * The record is the SAFE-to-publish view: it carries the derived `agentId`, the two
 * checksummed addresses it is derived from, and the `nameHash` COMMITMENT — never
 * the plaintext display name (that is held client-side, like the merchant name).
 */
export interface AgentIdentity {
  /** keccak256(abi.encode(owner, delegate)) — the agent's stable, durable key. */
  readonly agentId: Hex
  /** The granting account (checksummed) — the principal that delegated authority. */
  readonly owner: Hex
  /** The authorized spender (checksummed) — the agent the owner delegates to. */
  readonly delegate: Hex
  /**
   * keccak256(toHex(displayName)) — the on-the-wire COMMITMENT to the agent's human
   * name, or null when the caller supplied no name. NEVER the plaintext: mirrors the
   * merchant `nameHash` so the name the UI shows and the hash committed agree, with
   * the plaintext never leaving the client.
   */
  readonly nameHash: Hex | null
}

/** The ABI shape for the agent id preimage: two addresses, non-packed (matches the contract). */
const AGENT_ID_ABI = [{ type: 'address' }, { type: 'address' }] as const

/**
 * Normalize an EVM address to its checksummed form, or throw. NEVER invents an
 * address — a non-address input is a hard error (law #4: we don't fabricate a
 * principal). Uses viem's `getAddress`, which both validates and checksums.
 *
 * @param raw - the candidate address.
 * @param label - which field (for a clear error message).
 * @returns the checksummed address.
 */
function requireAddress(raw: unknown, label: 'owner' | 'delegate'): Hex {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`agent identity: ${label} address is required`)
  }
  try {
    return getAddress(raw.trim())
  } catch {
    throw new Error(`agent identity: ${label} must be a valid EVM address`)
  }
}

/**
 * The deterministic agent id for an (owner, delegate) pair.
 *
 * `keccak256(abi.encode(owner, delegate))` — the same non-packed encoding the
 * SessionGrant contract uses for its ids (sans nonce, because the AGENT outlives any
 * one session). Addresses are checksummed first, so the id is invariant to the input
 * casing: the SAME pair always yields the SAME id.
 *
 * @param owner - the granting account address.
 * @param delegate - the authorized spender (agent) address.
 * @returns the 0x-prefixed bytes32 agent id.
 * @throws if either address is malformed (never silently coerces to a zero address).
 */
export function computeAgentId(owner: unknown, delegate: unknown): Hex {
  const ownerAddr = requireAddress(owner, 'owner')
  const delegateAddr = requireAddress(delegate, 'delegate')
  return keccak256(encodeAbiParameters(AGENT_ID_ABI, [ownerAddr, delegateAddr]))
}

/**
 * keccak256(toHex(displayName)) — the on-the-wire COMMITMENT to an agent's human
 * name. Mirrors `RegisterForm`'s `keccak256(toHex(name))` and `branding/store`'s
 * `nameHashOf`, so the agent's name commitment and the merchant's name commitment
 * are the same shape. Returns null for an empty/blank name (nothing to commit).
 *
 * The plaintext name is NEVER required on-chain or on the wire; only this hash is.
 *
 * @param displayName - the raw human name; trimmed internally.
 * @returns the 0x-prefixed bytes32 hash, or null when there is no name.
 */
export function agentNameHash(displayName: string | null | undefined): Hex | null {
  const trimmed = (displayName ?? '').trim()
  if (trimmed.length === 0) return null
  return keccak256(toHex(trimmed))
}

/**
 * Build the deterministic, named agent identity record from an (owner, delegate)
 * pair and an OPTIONAL display name. The returned record is safe to publish: it
 * carries the derived `agentId`, the checksummed addresses, and the name COMMITMENT
 * (`nameHash`) only — the plaintext display name is held by the caller (client-side),
 * exactly like the merchant business name (law #4).
 *
 * @param input - the owner + delegate addresses, and an optional display name.
 * @returns a typed {@link AgentIdentity}.
 * @throws if either address is malformed.
 */
export function buildAgentIdentity(input: {
  owner: unknown
  delegate: unknown
  displayName?: string | null
}): AgentIdentity {
  const owner = requireAddress(input.owner, 'owner')
  const delegate = requireAddress(input.delegate, 'delegate')
  const agentId = keccak256(encodeAbiParameters(AGENT_ID_ABI, [owner, delegate]))
  return {
    agentId,
    owner,
    delegate,
    nameHash: agentNameHash(input.displayName),
  }
}
