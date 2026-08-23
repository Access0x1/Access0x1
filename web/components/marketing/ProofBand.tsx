import type { ReactNode } from 'react'

import { DEPLOYMENTS } from '@/lib/deployments'
import {
  CONFIRMED_MIRROR_COUNT,
  MIRROR_ROUTER,
  SOURCE_VERIFIED_COUNT,
  isPubliclyClaimable,
} from '@/lib/public-status'
import { CalcadaMedallion } from '@/components/marketing/Calcada'
import { cn } from '@/lib/utils'

/**
 * ProofBand — the landing page's one piece of evidence, laid as a calçada panel.
 *
 * WHY IT EXISTS. Everything above it on the page is a claim. A visitor with five
 * minutes and no wallet had nothing on the landing page they could check: the
 * primary CTA leads to a sign-in wall, and `/deployments` — the page that reads the
 * deployed bytecode live off every chain — was linked from nowhere at all. So the
 * strongest thing this project has, that the contracts are really there, was the one
 * thing a judge never saw.
 *
 * WHERE THE NUMBERS COME FROM. `lib/deployments.ts` is generated from `broadcast/`, so it
 * reports what a deploy script RECORDED — which is not the same as what is live. This band
 * previously rendered "9 testnets" by counting manifest entries carrying the mirror address,
 * and that UNDER-COUNTED: the mirror router also answers on 0G Galileo (16602), which has no
 * committed broadcast record at that address. Ten chains respond; nine are in the manifest.
 *
 * So the mirror count now comes from `lib/public-status.ts` — a list where a chain earns its
 * place by answering on its own RPC, not by appearing in a file. The manifest is still the
 * right source for the "chains deployed" total (it is a faithful count of deploy records,
 * pre-mirror chains included) and for the explorer deep-link.
 *
 * DESIGN. It borrows the calçada vocabulary rather than inventing a new one: the
 * medallion as the anchor, `currentColor` at low opacity so it is theme-aware by
 * construction, and a stone-seam rule between figures. Pure SVG + CSS, no images, no
 * client JS, no new dependency — the whole app installs from a clone.
 */

/**
 * Chains that BOTH carry the mirror router in the generated manifest AND are on the
 * reviewed confirmed list. The manifest alone is not sufficient evidence for a public
 * claim; the reviewed list is what gates it.
 */
function mirroredChains(): typeof DEPLOYMENTS {
  const wanted = MIRROR_ROUTER.toLowerCase()
  return DEPLOYMENTS.filter(
    (c) =>
      isPubliclyClaimable(c.chainId) &&
      c.deployments.some((d) => d.address.toLowerCase() === wanted),
  )
}

/** One figure in the band: a big number and what it counts. */
function Figure({
  value,
  label,
  sub,
}: {
  value: string
  label: string
  sub?: string
}): ReactNode {
  return (
    <div className="flex flex-col items-center px-6 py-2 text-center">
      <span className="font-display text-3xl font-semibold tracking-tight text-foreground tabular-nums sm:text-4xl">
        {value}
      </span>
      <span className="mt-1 text-sm font-medium text-foreground/80">{label}</span>
      {sub ? <span className="mt-0.5 text-xs text-muted-foreground">{sub}</span> : null}
    </div>
  )
}

export function ProofBand({ className }: { className?: string }): ReactNode {
  const mirrored = mirroredChains()
  // Every chain with a committed deploy record, pre-mirror ones included — which is what
  // the "including pre-mirror" label says. Accurate straight from the manifest.
  const totalChains = DEPLOYMENTS.length
  // The explorer link goes to a chain that genuinely carries the mirror. Preferring
  // one WITH an explorer avoids rendering a dead link; if none has one we show the
  // address as plain text rather than inventing a URL (the same rule chainMeta uses).
  const linkable = mirrored.find((c) => c.explorer)

  return (
    <section
      className={cn('relative mx-auto w-full max-w-5xl px-6 py-14', className)}
      aria-labelledby="proof-band-heading"
    >
      <div className="flex flex-col items-center">
        <CalcadaMedallion size={56} className="opacity-70" />

        <h2
          id="proof-band-heading"
          className="mt-4 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
        >
          One CREATE3 mirror address across {CONFIRMED_MIRROR_COUNT} testnets.
        </h2>
        <p className="mt-2 max-w-xl text-balance text-center text-sm text-muted-foreground">
          Not a roadmap — the mirror count is checked against each chain&rsquo;s own RPC,
          and every deploy record is in this repository. Open either before you trust a
          word above.
        </p>

        {/* The figures, separated by stone seams rather than hard borders. */}
        <div className="mt-8 flex w-full flex-col items-center divide-y divide-border/60 sm:flex-row sm:justify-center sm:divide-x sm:divide-y-0">
          <Figure
            value={String(CONFIRMED_MIRROR_COUNT)}
            label="testnets, one address"
            sub={`identical via CREATE3 · ${SOURCE_VERIFIED_COUNT} source-verified`}
          />
          <Figure value={String(totalChains)} label="chains deployed" sub="including pre-mirror" />
          <Figure value="0" label="custody, by construction" sub="settles in one transaction" />
        </div>

        {/* The address itself — the single most checkable fact on the page. */}
        <div className="mt-8 w-full max-w-2xl rounded-2xl border border-border bg-secondary/40 px-5 py-4 text-center">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Access0x1Router — the same proxy on every mirrored chain
          </p>
          <code className="mt-1.5 block break-all font-mono text-xs text-foreground sm:text-sm">
            {MIRROR_ROUTER}
          </code>
          <p className="mt-3 text-sm">
            <a
              className="text-primary underline-offset-2 hover:underline"
              href="/deployments"
            >
              Verify it live →
            </a>
            {linkable?.explorer ? (
              <>
                <span className="px-2 text-muted-foreground">·</span>
                <a
                  className="text-primary underline-offset-2 hover:underline"
                  href={`${linkable.explorer}/address/${MIRROR_ROUTER}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  On {linkable.name} ↗
                </a>
              </>
            ) : null}
          </p>
        </div>
      </div>
    </section>
  )
}

export default ProofBand
