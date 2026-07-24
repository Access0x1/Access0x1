/**
 * @file agentInference.test.ts — the ETH-native "agent decides to join 0G" resolver.
 *
 * Pins that the inference provider is read off the agent's Ethereum ENS name (`click.access0x1.
 * inference`), that only `zerog` opts in, and that any resolver failure / unset record degrades to
 * the safe `anthropic` default (never throws). The ENS read is fully mocked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { readAgentRecord } = vi.hoisted(() => ({
  readAgentRecord: vi.fn<(p: { name: string; key: string; rpcUrl?: string }) => Promise<string | null>>(),
}))
vi.mock('../../agent/ensIdentity', () => ({ readAgentRecord }))

import {
  AGENT_INFERENCE_RECORD_KEY,
  parseInferenceProvider,
  resolveAgentInferenceProvider,
} from '../agentInference.js'

afterEach(() => {
  readAgentRecord.mockReset()
})

describe('parseInferenceProvider', () => {
  it('maps "zerog" and "access0x1" (case/space-insensitive); everything else to anthropic', () => {
    expect(parseInferenceProvider('zerog')).toBe('zerog')
    expect(parseInferenceProvider('  ZeroG  ')).toBe('zerog')
    expect(parseInferenceProvider('access0x1')).toBe('access0x1')
    expect(parseInferenceProvider(' Access0x1 ')).toBe('access0x1')
    expect(parseInferenceProvider('anthropic')).toBe('anthropic')
    expect(parseInferenceProvider('')).toBe('anthropic')
    expect(parseInferenceProvider(null)).toBe('anthropic')
    expect(parseInferenceProvider(undefined)).toBe('anthropic')
  })
})

describe('resolveAgentInferenceProvider', () => {
  it('reads click.access0x1.inference off the agent ENS name and returns zerog when it opts in', async () => {
    readAgentRecord.mockResolvedValueOnce('zerog')
    const provider = await resolveAgentInferenceProvider('agent.acme.eth')
    expect(provider).toBe('zerog')
    expect(readAgentRecord).toHaveBeenCalledWith({
      name: 'agent.acme.eth',
      key: AGENT_INFERENCE_RECORD_KEY,
      rpcUrl: undefined,
    })
  })

  it('defaults to anthropic when the record is unset', async () => {
    readAgentRecord.mockResolvedValueOnce(null)
    expect(await resolveAgentInferenceProvider('agent.acme.eth')).toBe('anthropic')
  })

  it('never throws — a resolver error degrades to anthropic', async () => {
    readAgentRecord.mockRejectedValueOnce(new Error('rpc down'))
    expect(await resolveAgentInferenceProvider('agent.acme.eth', 'https://rpc')).toBe('anthropic')
  })
})
