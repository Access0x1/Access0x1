/**
 * encode.test.ts — the console's input coercion is the last guard before a
 * typed call, so it must reject bad input LOUDLY (never a silently wrong-typed
 * arg) and coerce good input exactly. Also pins result/error formatting.
 */
import { describe, expect, it } from 'vitest'
import type { AbiParameter } from 'viem'
import { formatResult, humanizeError, isComplexType, parseArg } from './encode'

const p = (type: string, name = '', components?: readonly AbiParameter[]): AbiParameter =>
  ({ type, name, ...(components ? { components } : {}) }) as AbiParameter

describe('parseArg — scalars', () => {
  it('accepts a lowercase address and normalizes it', () => {
    const addr = '0xE92244E3368561faf21648146511DeDE3a475EB5'
    expect(parseArg(p('address'), addr)).toBe(addr.toLowerCase())
  })

  it('rejects a non-address', () => {
    expect(() => parseArg(p('address'), '0x123')).toThrow(/valid address/)
  })

  it('coerces uint to bigint and rejects negatives / non-numbers', () => {
    expect(parseArg(p('uint256'), '42')).toBe(42n)
    expect(() => parseArg(p('uint256'), '-1')).toThrow(/negative/)
    expect(() => parseArg(p('uint256'), 'x')).toThrow(/whole number/)
  })

  it('allows a negative int', () => {
    expect(parseArg(p('int256'), '-5')).toBe(-5n)
  })

  it('parses bool from words and 0/1', () => {
    expect(parseArg(p('bool'), 'true')).toBe(true)
    expect(parseArg(p('bool'), '0')).toBe(false)
    expect(() => parseArg(p('bool'), 'maybe')).toThrow(/true or false/)
  })

  it('validates bytes32 length + hex', () => {
    const ok = '0x' + 'ab'.repeat(32)
    expect(parseArg(p('bytes32'), ok)).toBe(ok)
    expect(() => parseArg(p('bytes32'), '0xabcd')).toThrow(/exactly 32 bytes/)
    expect(() => parseArg(p('bytes32'), 'nothex')).toThrow(/0x-hex/)
  })

  it('passes a string through unchanged', () => {
    expect(parseArg(p('string'), 'hello world')).toBe('hello world')
  })
})

describe('parseArg — complex', () => {
  it('flags array/tuple types as complex', () => {
    expect(isComplexType('address[]')).toBe(true)
    expect(isComplexType('tuple')).toBe(true)
    expect(isComplexType('uint256')).toBe(false)
  })

  it('coerces an address[] from JSON', () => {
    const a = '0x1111111111111111111111111111111111111111'
    const b = '0x2222222222222222222222222222222222222222'
    expect(parseArg(p('address[]'), `["${a}","${b}"]`)).toEqual([a, b])
  })

  it('rejects a bad element inside an array', () => {
    expect(() => parseArg(p('uint256[]'), '["1","x"]')).toThrow(/whole number/)
  })

  it('maps a tuple object onto its components (uint→bigint)', () => {
    const tuple = p('tuple', 't', [p('uint256', 'amount'), p('address', 'to')])
    const to = '0x3333333333333333333333333333333333333333'
    expect(parseArg(tuple, `{"amount":"7","to":"${to}"}`)).toEqual([7n, to])
  })

  it('rejects non-JSON for a complex type', () => {
    expect(() => parseArg(p('uint256[]'), 'not json')).toThrow(/as JSON/)
  })
})

describe('formatResult', () => {
  it('renders a top-level bigint as plain decimal', () => {
    expect(formatResult(10n)).toBe('10')
  })

  it('renders nested bigints as strings', () => {
    expect(formatResult({ fee: 5n, active: true })).toContain('"fee": "5"')
  })

  it('names a void return explicitly', () => {
    expect(formatResult(undefined)).toBe('ok — no return value')
  })
})

describe('humanizeError', () => {
  it('prefers viem shortMessage', () => {
    expect(humanizeError({ shortMessage: 'reverted: Underpaid', message: 'long...' })).toBe(
      'reverted: Underpaid',
    )
  })

  it('falls back to message and truncates long text', () => {
    expect(humanizeError(new Error('boom'))).toBe('boom')
    expect(humanizeError(new Error('x'.repeat(400))).endsWith('…')).toBe(true)
  })
})
