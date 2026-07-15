/**
 * rail-seams.test.ts — the indexed-source seam is dormant-by-default and flips
 * on from ONE env var; a blank value must read as dormant (a wholesale-copied
 * .env.example can't accidentally "switch it on" with an empty string).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { indexedEventSourceUrl, isIndexedSourceActive, railSeamStatus } from './rail-seams'

const ENV = 'NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL'

afterEach(() => {
  delete process.env[ENV]
})

describe('indexed event source seam', () => {
  it('is dormant when unset', () => {
    expect(indexedEventSourceUrl()).toBeUndefined()
    expect(isIndexedSourceActive()).toBe(false)
  })

  it('stays dormant for a blank value', () => {
    process.env[ENV] = '   '
    expect(indexedEventSourceUrl()).toBeUndefined()
    expect(isIndexedSourceActive()).toBe(false)
  })

  it('activates and trims when set', () => {
    process.env[ENV] = '  https://indexer.example/graphql  '
    expect(indexedEventSourceUrl()).toBe('https://indexer.example/graphql')
    expect(isIndexedSourceActive()).toBe(true)
  })
})

describe('railSeamStatus', () => {
  it('reports both seams', () => {
    const status = railSeamStatus()
    expect(status.indexedSource).toBe(false)
    expect(status.settlementStrategy).toBe('direct')
  })
})
