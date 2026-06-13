'use client'

import type { ReactNode } from 'react'
import { explorerTxUrl } from '@/lib/chains'

/** Shorten a 0x hash for display: 0x1234…abcd. */
function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash
}

/**
 * Render a transaction hash. When a verifiable block explorer is known for the
 * chain ({@link explorerTxUrl} returns a url), render a shortened link that
 * opens in a new tab; otherwise render the FULL hash as selectable monospace
 * text — never an invented or broken link (law #4).
 *
 * `full` keeps the un-shortened hash as text in the no-explorer case (used by
 * surfaces that want the whole hash copyable, e.g. the receipt).
 */
export function TxHashLink({
  chainId,
  hash,
  full = false,
  className,
}: {
  chainId: number
  hash: string
  full?: boolean
  className?: string
}): ReactNode {
  const url = explorerTxUrl(chainId, hash)
  if (!url) {
    return <span className={className ?? 'font-mono'}>{full ? hash : shortHash(hash)}</span>
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={className ?? 'font-mono text-rail underline-offset-2 hover:underline'}
    >
      {shortHash(hash)}
    </a>
  )
}
