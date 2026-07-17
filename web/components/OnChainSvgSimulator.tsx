'use client'

import { useState, type ChangeEvent, type ReactNode } from 'react'
import { SUPPORTED_CHAINS, getDefaultChainId } from '@/lib/chains'
import { toInlineSvgLogo, LogoError } from '@/lib/branding/logo'
import { fileToDataUri } from '@/lib/branding/client'
import { formatGas } from '@/lib/onchain-svg/estimate'
import type { OnchainSvgReport, GasRegime } from '@/lib/onchain-svg/report'

/**
 * OnChainSvgSimulator — upload an SVG (or raster) and see, provably, what it
 * WOULD HAVE COST if it had just run on-chain. Nothing is ever broadcast:
 * the mark is sanitized with the branding scrubber, priced from first
 * principles under four real storage strategies (every breakdown line carries
 * its own formula), then cross-checked against the LIVE testnet node via
 * /api/onchain-estimate — a zero-value estimateGas of the exact bytes, the
 * spot gas price, and the router's own Chainlink-guarded $1 quote.
 *
 * The container owns file reading + the API call; every rendered state lives
 * in the pure {@link OnChainSvgSimulatorView} (the NetworkBadge SSR-test
 * discipline).
 */

/** The live half of the API answer (all bigints as decimal strings). */
export interface LiveCheck {
  chainId: number
  selfSendGas: string | null
  gasPriceWei: string | null
  weiPerUsd: string | null
  regime: GasRegime | null
  errors: string[]
}

/** The API response: the pure report plus the live cross-check. */
export type SimulatorReport = OnchainSvgReport & { live: LiveCheck }

type SimState =
  | { phase: 'idle' }
  | { phase: 'working'; note: string }
  | { phase: 'error'; message: string }
  | { phase: 'done'; report: SimulatorReport }

export function OnChainSvgSimulator({
  className,
  onSimulated,
}: {
  className?: string
  /** Fires on each successful report — the journey's artwork step listens. */
  onSimulated?: () => void
}): ReactNode {
  const [chainId, setChainId] = useState<number>(getDefaultChainId())
  const [state, setState] = useState<SimState>({ phase: 'idle' })

  async function handleFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    if (!file) return
    setState({ phase: 'working', note: 'Reading the file…' })
    try {
      // SVG rides as text; a raster becomes a data-URI the sanitizer wraps.
      const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')
      const input = isSvg ? await file.text() : await fileToDataUri(file)
      // Client-side pre-flight with the SAME pure sanitizer the server runs —
      // instant honest rejection, no round-trip for junk.
      toInlineSvgLogo(input)
      setState({ phase: 'working', note: 'Running the math + asking the live node…' })
      const res = await fetch('/api/onchain-estimate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chainId, svg: input }),
        cache: 'no-store',
      })
      const body = (await res.json()) as SimulatorReport & { error?: string }
      if (!res.ok || body.error) {
        setState({ phase: 'error', message: body.error ?? `Estimate failed (${res.status})` })
        return
      }
      setState({ phase: 'done', report: body })
      onSimulated?.()
    } catch (err) {
      const message =
        err instanceof LogoError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not read that file.'
      setState({ phase: 'error', message })
    } finally {
      // Allow re-uploading the same file (the input keeps its value otherwise).
      e.target.value = ''
    }
  }

  return (
    <OnChainSvgSimulatorView
      state={state}
      chainId={chainId}
      chains={SUPPORTED_CHAINS.map((c) => ({ id: c.id, name: c.name }))}
      onChainChange={(id) => setChainId(id)}
      onFile={(e) => void handleFile(e)}
      className={className}
    />
  )
}

/** One display row of the strategy table, derived purely from the report. */
export interface StrategyRow {
  strategy: string
  title: string
  description: string
  txCount: number
  /** The gas figure the LIVE regime says applies (floor when 7623, else legacy). */
  gas: string
  /** The other regime's figure when it differs, for the honest side-note. */
  altGas: string | null
  nativeCost: string | null
  usdCost: string | null
  breakdown: { label: string; formula: string; gas: string }[]
  notes: string[]
}

/**
 * Derive the display rows: pick each strategy's regime-appropriate total
 * (EIP-7623 floor when the live node proved that regime, legacy otherwise),
 * and price it in native + USD when the live rates arrived. Pure — tested
 * offline with a canned report.
 */
export function deriveRows(report: SimulatorReport): StrategyRow[] {
  const use7623 = report.live.regime === 'eip7623'
  const gasPrice = report.live.gasPriceWei ? BigInt(report.live.gasPriceWei) : null
  const weiPerUsd = report.live.weiPerUsd ? BigInt(report.live.weiPerUsd) : null
  return report.strategies.map((s) => {
    const gas = use7623 ? s.gasFloor : s.gasLegacy
    const alt = use7623 ? s.gasLegacy : s.gasFloor
    const wei = gasPrice !== null ? BigInt(gas) * gasPrice : null
    const usd8 = wei !== null && weiPerUsd !== null && weiPerUsd > 0n ? (wei * 100_000_000n) / weiPerUsd : null
    return {
      strategy: s.strategy,
      title: s.title,
      description: s.description,
      txCount: s.txCount,
      gas,
      altGas: alt !== gas ? alt : null,
      nativeCost: wei !== null ? formatNativeWei(wei) : null,
      usdCost: usd8 !== null ? formatUsd8(usd8) : null,
      breakdown: s.breakdown,
      notes: s.notes,
    }
  })
}

/** Wei → native display with adaptive precision ("0.000413"). Pure. */
export function formatNativeWei(wei: bigint): string {
  const native = Number(wei) / 1e18
  if (native === 0) return '0'
  if (native >= 1) return native.toFixed(4)
  return native.toPrecision(3)
}

/** 8-decimal USD int → display ("$1.24", "$0.0004"). Pure. */
export function formatUsd8(usd8: bigint): string {
  const usd = Number(usd8) / 1e8
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  if (usd === 0) return '$0.00'
  return `$${usd.toPrecision(2)}`
}

/**
 * Encode a sanitized inline SVG as an `<img src>` data URI. URL-encoding (not
 * base64) keeps it readable and small; the `#` and `%`-class chars that would
 * break the URI are escaped. Rendered through `<img>`, the SVG is inert — no
 * script, no handlers, no network — so this stays safe even if the upstream
 * sanitizer ever regresses (defense in depth for a public surface).
 */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** Human text for the regime chip — never overclaims (law #4). */
export function regimeLabel(regime: GasRegime | null): string {
  switch (regime) {
    case 'legacy':
      return 'Legacy calldata pricing (EIP-2028: 16/4 per byte)'
    case 'eip7623':
      return 'EIP-7623 floor pricing (Prague: ≥10 gas per token)'
    case 'other':
      return 'Chain-specific pricing (matches neither standard regime — e.g. an L2 data fee)'
    default:
      return 'Live check unavailable — showing the pure math'
  }
}

/**
 * Pure presentational simulator — deterministically SSR-testable; states are
 * tagged `data-onchain-sim`. The preview renders the SANITIZED SVG only, via
 * the same `dangerouslySetInnerHTML`+`scaleSvg` contract as BrandPreview
 * (server-scrubbed, re-sanitized on resize — lib/branding/logo.ts).
 */
export function OnChainSvgSimulatorView({
  state,
  chainId,
  chains,
  onChainChange,
  onFile,
  className,
}: {
  state: SimState
  chainId: number
  chains: readonly { id: number; name: string }[]
  onChainChange: (chainId: number) => void
  onFile: (e: ChangeEvent<HTMLInputElement>) => void
  className?: string
}): ReactNode {
  return (
    <section
      data-onchain-sim={state.phase}
      className={`flex flex-col gap-4 rounded-xl border border-border bg-card p-5 ${className ?? ''}`}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-ink">Your art, as if it ran on-chain</h2>
        <p className="text-sm text-muted-foreground">
          Upload an SVG (or PNG/JPG) and get a provable estimate of what storing it on-chain would
          have cost <em>if it had just run</em> — pure EVM math, cross-checked against the live
          testnet node. Nothing is broadcast; nothing is signed.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Network</span>
          <select
            value={chainId}
            onChange={(e) => onChainChange(Number(e.target.value))}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-rail"
          >
            {chains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Artwork</span>
          <input
            type="file"
            accept="image/svg+xml,.svg,image/png,image/jpeg,image/webp,image/gif"
            onChange={onFile}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-rail file:px-3 file:py-1 file:text-xs file:font-medium file:text-white"
          />
        </label>
      </div>

      {state.phase === 'working' ? (
        <p className="text-sm text-muted-foreground" data-testid="sim-working">
          {state.note}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <p className="text-sm text-red-600" data-testid="sim-error">
          {state.message}
        </p>
      ) : null}
      {state.phase === 'done' ? <SimulatorResult report={state.report} /> : null}
    </section>
  )
}

/** The result panel — pure, fed only by the API report. */
export function SimulatorResult({ report }: { report: SimulatorReport }): ReactNode {
  const rows = deriveRows(report)
  const live = report.live
  const scrubbed = report.rawBytes - report.sanitized.bytes
  return (
    <div className="flex flex-col gap-4" data-testid="sim-result">
      <div className="flex items-start gap-4">
        {/* Defense in depth: the mark is already server-sanitized, but this is
            a PUBLIC, unauthenticated surface — render it through an <img> data
            URI (an SVG loaded via <img> can never execute script, event
            handlers, or fetch), never dangerouslySetInnerHTML. Even a future
            sanitizer regression cannot become XSS here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={svgToDataUri(report.sanitizedSvg)}
          alt="Your uploaded mark"
          width={72}
          height={72}
          className="inline-block shrink-0 overflow-hidden rounded-xl border border-border bg-background"
        />
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-ink">
            <span className="font-semibold">{formatGas(report.sanitized.bytes)} bytes</span> after
            sanitizing ({formatGas(report.sanitized.nonzeroBytes)} nonzero ·{' '}
            {formatGas(report.sanitized.zeroBytes)} zero)
            {scrubbed > 0 ? (
              <span className="text-muted-foreground"> — the scrubber removed {formatGas(scrubbed)} bytes</span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="sim-regime">
            {regimeLabel(live.regime)}
          </p>
        </div>
      </div>

      <div
        className="rounded-lg border border-rail/40 bg-rail/5 px-4 py-3 text-sm"
        data-testid="sim-live"
      >
        {live.selfSendGas ? (
          <p className="text-ink">
            If publishing these exact bytes had run just now, the live node says it would have used{' '}
            <span className="font-semibold">{formatGas(BigInt(live.selfSendGas))} gas</span>
            {' '}(math predicted {formatGas(BigInt(report.predictedLegacy))} legacy /{' '}
            {formatGas(BigInt(report.predictedFloor))} floor).
          </p>
        ) : (
          <p className="text-muted-foreground">
            The live node could not be reached — the pure math below still stands.
          </p>
        )}
        {live.errors.length > 0 ? (
          <p className="mt-1 text-xs text-amber-600">{live.errors.join(' · ')}</p>
        ) : null}
      </div>

      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li
            key={row.strategy}
            data-testid={`sim-strategy-${row.strategy}`}
            className="rounded-lg border border-border bg-background p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium text-ink">{row.title}</p>
              <p className="text-sm text-ink">
                <span className="font-semibold">{formatGas(BigInt(row.gas))} gas</span>
                {row.nativeCost ? <span className="text-muted-foreground"> ≈ {row.nativeCost} native</span> : null}
                {row.usdCost ? <span className="text-muted-foreground"> ≈ {row.usdCost}</span> : null}
              </p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.description}
              {row.txCount > 1 ? ` Needs ${row.txCount} transactions.` : ''}
              {row.altGas ? ` Under the other pricing regime: ${formatGas(BigInt(row.altGas))} gas.` : ''}
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-rail">
                Show the math
              </summary>
              <table className="mt-2 w-full text-left text-xs">
                <tbody>
                  {row.breakdown.map((line) => (
                    <tr key={line.label} className="border-t border-border/60">
                      <td className="py-1 pr-2 text-muted-foreground">{line.label}</td>
                      <td className="py-1 pr-2 font-mono text-[11px] text-muted-foreground">{line.formula}</td>
                      <td className="py-1 text-right font-mono text-ink">{formatGas(BigInt(line.gas))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {row.notes.map((n) => (
                <p key={n} className="mt-1 text-[11px] text-muted-foreground">
                  {n}
                </p>
              ))}
            </details>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">
        Simulation only — no transaction was created, signed, or broadcast. Figures are
        spec-derived lower bounds; USD uses the router’s own oracle-guarded $1 quote.
      </p>
    </div>
  )
}
