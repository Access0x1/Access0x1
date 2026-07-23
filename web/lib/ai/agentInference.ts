/**
 * @file agentInference.ts — let an ETHEREUM-native agent DECIDE to join 0G, via its ENS name.
 *
 * An Access0x1 agent lives entirely on Ethereum: its identity is an ENS name (+ `SessionGrant`),
 * its money is the USDC router. It does NOT deploy to the 0G chain. So how does it "join 0G" for
 * inference? It publishes a single text record on its own Ethereum ENS name:
 *
 *     click.access0x1.inference = "zerog"      → this agent's inference runs on 0G Compute
 *     click.access0x1.inference = "anthropic"  → (or unset) the default backend
 *
 * This module reads that record off the agent's ETH name (a plain ENS resolver READ — the same
 * money-path-safe path {@link readAgentRecord} already uses) and maps it to an
 * {@link InferenceProvider} the {@link runInference} call can honor per-request. The decision thus
 * lives in the agent's Ethereum identity and is flippable by the name owner at any time — no 0G
 * deployment, no code change, no redeploy. The operator's funded 0G broker (see `inference.ts`)
 * does the paying only when an agent has opted in.
 *
 * Doctrine: READ-ONLY, no key, never throws — an unset/unknown record or any resolver error
 * degrades to the default `anthropic` provider (fail-soft, law #4). It is a discovery hint, not a
 * money path.
 */

import { readAgentRecord } from '../agent/ensIdentity'
import type { InferenceProvider } from './inference'

/**
 * The ENS text-record key an agent sets on its Ethereum name to declare its inference backend.
 * Part of the shared `click.access0x1.*` schema the payment resolver + subname issuer already use.
 */
export const AGENT_INFERENCE_RECORD_KEY = 'click.access0x1.inference'

/** Map a raw record value to a known provider; anything else (incl. null) ⇒ the default. */
export function parseInferenceProvider(value: string | null | undefined): InferenceProvider {
  return typeof value === 'string' && value.trim().toLowerCase() === 'zerog' ? 'zerog' : 'anthropic'
}

/**
 * Read the agent's declared inference provider off its Ethereum ENS name. Never throws: a missing
 * record or any resolver failure resolves to `anthropic` (the safe default) — joining 0G is opt-in.
 *
 * @param name The agent's ENS name (e.g. `agent.acme.eth`).
 * @param rpcUrl Optional mainnet RPC override.
 * @returns The provider the agent has chosen (`zerog` iff it explicitly opted in).
 */
export async function resolveAgentInferenceProvider(
  name: string,
  rpcUrl?: string,
): Promise<InferenceProvider> {
  try {
    const value = await readAgentRecord({ name, key: AGENT_INFERENCE_RECORD_KEY, rpcUrl })
    return parseInferenceProvider(value)
  } catch {
    return 'anthropic'
  }
}
