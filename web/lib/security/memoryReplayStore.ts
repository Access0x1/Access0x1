/**
 * memoryReplayStore.ts — the DEV-ONLY in-memory replay store.
 *
 * A process-lifetime `Set` of `${namespace} ${key}` composite keys, pinned on
 * `globalThis` so Next.js route-module instances + dev hot-reload share one set.
 * This is the original R-2-vulnerable behavior, now quarantined behind the
 * `ReplayStore` interface and reachable ONLY in development: the factory
 * (`getReplayStore`) refuses it in production and fails closed instead.
 *
 * Async to satisfy the `ReplayStore` contract — it just resolves immediately.
 */

import type { ReplayStore } from './replayStore.js'

const GLOBAL_KEY = '__ax1_replay_memory__'

interface MemStore {
  seen: Set<string>
}

function store(): MemStore {
  const g = globalThis as unknown as Record<string, MemStore | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { seen: new Set<string>() }
  return g[GLOBAL_KEY] as MemStore
}

/** The composite key — a space-joined `(namespace, key)`, matching the SQL UNIQUE. */
function composite(namespace: string, key: string): string {
  return `${namespace} ${key}`
}

/** Build the in-memory dev replay store (NOT for production — see the factory). */
export function createMemoryReplayStore(): ReplayStore {
  return {
    async claim(namespace: string, key: string): Promise<boolean> {
      const s = store()
      const k = composite(namespace, key)
      if (s.seen.has(k)) return false // ON CONFLICT → replay
      s.seen.add(k)
      return true
    },
    async has(namespace: string, key: string): Promise<boolean> {
      return store().seen.has(composite(namespace, key))
    },
  }
}

/** Test-only: wipe the pinned in-memory set. */
export function __resetMemoryReplayStore(): void {
  const g = globalThis as unknown as Record<string, MemStore | undefined>
  g[GLOBAL_KEY] = { seen: new Set<string>() }
}
