/**
 * @file ensIdentity.ts — bind an Access0x1 AGENT identity to a real ENS name.
 *
 * `identity.ts` gives an agent a deterministic `agentId` (keccak of owner+delegate) and a
 * name COMMITMENT — but an agent identified only by a hash is not DISCOVERABLE: a human or
 * another agent cannot look it up by a human name, and cannot independently VERIFY that a
 * given ENS name really speaks for that agent. This module closes that gap with ENS, the
 * standard multichain identity layer for AI agents:
 *
 *  - ENSIP-25 (AI Agent Registry ENS Name Verification): a parameterized text-record key
 *    `agent-registration[<registry>][<agentId>]` whose non-empty value is the name owner's
 *    attestation that the name is bound to that agent registry entry. We CONSTRUCT that key
 *    (incl. the ERC-7930 interoperable registry address) and VERIFY it by a single resolver
 *    read — exactly the spec's Registry-to-ENS flow.
 *  - ENSIP-26 (Agent Text Records): the `agent-context` entry-point record and the
 *    `agent-endpoint[<protocol>]` interface-discovery records. We expose their keys + reads.
 *  - ENSIP-11/19 coinType resolution (via {@link resolveENS}) so the name → delegate-address
 *    check is money-path-safe on L2s (never the unguarded mainnet-address fallback).
 *
 * Doctrine:
 *  - READ-ONLY + no key: every network call is an ENS resolver READ over the public mainnet
 *    resolver (`mainnetClient`), the same path the merchant payout resolution already uses.
 *    Nothing here writes a record, holds a key, moves value, or touches the router CEI path.
 *  - NEVER invents: a malformed registry address / an `agentId` carrying the reserved `[` `]`
 *    characters THROWS rather than silently producing a wrong key (law #4).
 *  - Spec-exact: the ERC-7930 encoding is verified byte-for-byte against the ENSIP-25 example
 *    (ERC-8004 on mainnet) in the test suite — no hand-waved address format.
 */

import { getAddress, type Hex } from 'viem'
import { normalize } from 'viem/ens'
import { mainnetClient, resolveENS } from '../ens'
import { computeAgentId, type AgentIdentity } from './identity'

/** ERC-7930 version tag for the current interoperable-address format (2 bytes). */
const ERC7930_VERSION = '0001'
/** ERC-7930 chain type for EIP-155 / EVM chains (2 bytes). */
const ERC7930_CHAINTYPE_EIP155 = '0000'

/**
 * The ERC-8004 Agent Registry on Ethereum mainnet, as published in the ENSIP-25 example.
 * Provided as a documented convenience for the common registry; every function below takes
 * the registry as an argument, so this is never a hidden default.
 * @see ENSIP-25 §"Ethereum Example".
 */
export const ERC8004_MAINNET_REGISTRY = {
  chainId: 1,
  address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as Hex,
} as const

/** A registry the agent is (or claims to be) registered in — an EVM contract on a chain. */
export interface AgentRegistry {
  /** EIP-155 chain id of the registry contract. */
  readonly chainId: number
  /** The registry contract address (any case — checksummed internally). */
  readonly address: string
}

/** A reserved-character guard: ENSIP-25/26 forbid `[` and `]` inside the parameter segments. */
function requireNoBrackets(value: string, label: string): string {
  if (value.includes('[') || value.includes(']')) {
    throw new Error(`ensIdentity: ${label} must not contain '[' or ']' (ENSIP-25/26 reserved): ${value}`)
  }
  return value
}

/** Minimal big-endian byte encoding of a non-negative integer (≥ 1 byte). */
function minimalBeHex(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`ensIdentity: chainId must be a non-negative integer, got ${n}`)
  }
  let hex = n.toString(16)
  if (hex.length % 2 === 1) hex = '0' + hex
  return hex === '' ? '00' : hex
}

/**
 * Encode an EVM contract as an ERC-7930 interoperable address (the `<registry>` segment of
 * the ENSIP-25 key): `version‖chainType‖chainRefLen‖chainRef‖addrLen‖address`, all hex.
 * The chain reference is the EIP-155 chain id as minimal big-endian bytes; the address is
 * the 20-byte (`0x14`) contract address.
 *
 * Verified against the ENSIP-25 mainnet example: ERC-8004 `0x8004…a432` on chain 1 →
 * `0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432`.
 *
 * @param chainId EIP-155 chain id of the registry.
 * @param address The registry contract address (checksummed internally; emitted lowercase).
 * @returns The 0x-prefixed ERC-7930 interoperable address (lowercase, per the spec example).
 * @throws if the address is not a valid EVM address.
 */
export function erc7930EvmAddress(chainId: number, address: string): Hex {
  const addr = getAddress(address).slice(2).toLowerCase() // 20 bytes, no 0x, lowercase
  const chainRef = minimalBeHex(chainId)
  const chainRefLen = (chainRef.length / 2).toString(16).padStart(2, '0')
  const addrLen = '14' // 20 bytes
  return `0x${ERC7930_VERSION}${ERC7930_CHAINTYPE_EIP155}${chainRefLen}${chainRef}${addrLen}${addr}` as Hex
}

/**
 * Build the ENSIP-25 verification text-record key `agent-registration[<registry>][<agentId>]`
 * for an agent in a registry. The non-empty value of this key on the claimed ENS name is the
 * owner's attestation of the binding.
 *
 * @param registry The agent registry (chain id + contract address).
 * @param agentId The registry-defined agent identifier (e.g. the Access0x1 `agentId` hash, or
 *                an ERC-8004 numeric id). Must not contain `[` or `]`.
 * @returns The fully-formed text-record key.
 */
export function agentRegistrationKey(registry: AgentRegistry, agentId: string): string {
  const reg = erc7930EvmAddress(registry.chainId, registry.address)
  const id = requireNoBrackets(agentId, 'agentId')
  return `agent-registration[${reg}][${id}]`
}

/** The ENSIP-26 `agent-context` entry-point text-record key. */
export const AGENT_CONTEXT_KEY = 'agent-context'

/**
 * Build the ENSIP-26 `agent-endpoint[<protocol>]` interface-discovery key.
 * @param protocol The interface protocol (e.g. `a2a`, `mcp`). Must not contain `[` or `]`.
 */
export function agentEndpointKey(protocol: string): string {
  return `agent-endpoint[${requireNoBrackets(protocol, 'protocol')}]`
}

/**
 * The record the ENS-name owner SHOULD set to attest that their name speaks for this agent:
 * the ENSIP-25 key for the agent's Access0x1 `agentId` in `registry`, with value `"1"`.
 * Pure — derives the (key, value) the owner publishes; performs no network call.
 *
 * @param identity The agent identity (its `agentId` is used as the ENSIP-25 `<agentId>`).
 * @param registry The registry the agent is registered in.
 * @returns The `{ key, value }` to set on the ENS name.
 */
export function expectedAgentRegistration(
  identity: AgentIdentity,
  registry: AgentRegistry,
): { key: string; value: '1' } {
  return { key: agentRegistrationKey(registry, identity.agentId), value: '1' }
}

/**
 * ENSIP-25 Registry-to-ENS verification: read the `agent-registration[<registry>][<agentId>]`
 * text record on `name` and report whether it carries a non-empty (⇒ attesting) value.
 * A single resolver read; never throws on a missing record (an absent/empty value is a clean
 * `false`, the spec's "verification MUST fail" outcome).
 *
 * @param params.name The claimed ENS name.
 * @param params.registry The agent registry.
 * @param params.agentId The registry-defined agent id.
 * @param params.rpcUrl Optional mainnet RPC override (else the public default).
 * @returns true iff the name attests the agent registry binding.
 */
export async function verifyAgentRegistration(params: {
  name: string
  registry: AgentRegistry
  agentId: string
  rpcUrl?: string
}): Promise<boolean> {
  const key = agentRegistrationKey(params.registry, params.agentId)
  const value = await mainnetClient(params.rpcUrl).getEnsText({
    name: normalize(params.name),
    key,
  })
  return typeof value === 'string' && value.length > 0
}

/**
 * Read an ENSIP-26 text record (`agent-context` or `agent-endpoint[<protocol>]`) on `name`.
 * Returns the raw string value, or null when the record is unset.
 *
 * @param params.name The ENS name.
 * @param params.key The text-record key (use {@link AGENT_CONTEXT_KEY} / {@link agentEndpointKey}).
 * @param params.rpcUrl Optional mainnet RPC override.
 */
export async function readAgentRecord(params: {
  name: string
  key: string
  rpcUrl?: string
}): Promise<string | null> {
  return mainnetClient(params.rpcUrl).getEnsText({
    name: normalize(params.name),
    key: params.key,
  })
}

/** The outcome of a full bidirectional agent ↔ ENS binding check. */
export interface AgentBindingResult {
  /** The name resolves (coinType-safe) to the agent's delegate address on the settlement chain. */
  readonly addressMatches: boolean
  /** The name carries the ENSIP-25 attestation for this agent's registry entry. */
  readonly registrationAttested: boolean
  /** Both legs hold — the name verifiably speaks for this agent. */
  readonly bound: boolean
}

/**
 * The strong, bidirectional check that an ENS `name` verifiably speaks for `identity`:
 *  1. the name RESOLVES (ENSIP-11 coinType for the settlement chain) to the agent's delegate
 *     address — so paying/looking up the name reaches the agent, not a stale mainnet entry; AND
 *  2. the name ATTESTS the ENSIP-25 `agent-registration` binding for the agent's `agentId`.
 * Either leg failing ⇒ `bound: false` (resolution failure is caught and reported, not thrown,
 * so a partial binding is observable rather than a crash).
 *
 * @param params.name The claimed ENS name.
 * @param params.identity The Access0x1 agent identity.
 * @param params.registry The registry the agent is registered in.
 * @param params.settlementChainId The chain whose coinType resolution must reach the delegate.
 * @param params.rpcUrl Optional mainnet RPC override.
 */
export async function verifyAgentBinding(params: {
  name: string
  identity: AgentIdentity
  registry: AgentRegistry
  settlementChainId: number
  rpcUrl?: string
}): Promise<AgentBindingResult> {
  // The identity must be internally consistent: `agentId` MUST be the keccak of
  // (owner, delegate). Leg 1 pins the addr to `delegate` and leg 2 pins the
  // attestation to `agentId`, independently — so a SPLICED identity
  // `{ agentId: G, delegate: D, owner: X }` where G is not derived from D could
  // otherwise pass both legs against mismatched halves, and "this name speaks
  // for THIS agent" would rest on an assumption the verifier never checked.
  // Re-derive and compare; an inconsistent identity is not a real binding.
  // Wrapped so a malformed owner/delegate degrades to `false`, never throws
  // (the documented no-throw contract).
  let consistent = false
  try {
    consistent = computeAgentId(params.identity.owner, params.identity.delegate) === params.identity.agentId
  } catch {
    consistent = false
  }
  if (!consistent) {
    return { addressMatches: false, registrationAttested: false, bound: false }
  }

  const [addressMatches, registrationAttested] = await Promise.all([
    resolveENS(params.name, params.settlementChainId, params.rpcUrl)
      .then((addr) => getAddress(addr) === getAddress(params.identity.delegate))
      .catch(() => false),
    // SYMMETRIC catch: the attestation read must degrade to false on any failure
    // (an RPC/getEnsText error, or a malformed registry address that makes
    // agentRegistrationKey throw), NOT reject out of verifyAgentBinding — the
    // resolution leg is already caught, and the doc promises "reported, not
    // thrown, so a partial binding is observable rather than a crash".
    verifyAgentRegistration({
      name: params.name,
      registry: params.registry,
      agentId: params.identity.agentId,
      rpcUrl: params.rpcUrl,
    }).catch(() => false),
  ])
  return { addressMatches, registrationAttested, bound: addressMatches && registrationAttested }
}
