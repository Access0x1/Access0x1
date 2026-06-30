'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { parseAbiItem, type Address } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { getDefaultChainId, getRouterAddress, tokenDecimalsFor } from '@/lib/chains'
import { getPublicClient } from '@/lib/wallet'
import { amount8ToUsd, formatTokenAmount } from '@/lib/quote'
import { ConnectButton } from '@/components/ConnectButton'
import { TxHashLink } from '@/components/TxHashLink'
import { GatewayBalanceCard } from '@/components/GatewayBalanceCard'
import { RegisterForm, type RegisterResult } from '@/components/RegisterForm'
import { LinkCard } from '@/components/LinkCard'
import { attachOnChain, loadBranding } from '@/lib/branding/client'
import { resolveMerchantId } from '@/lib/branding/merchantId'

const PAYMENT_RECEIVED_EVENT = parseAbiItem(
  'event PaymentReceived(uint256 indexed merchantId, address indexed buyer, address indexed token, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, uint256 usdAmount8, bytes32 orderId, uint64 srcChainSelector)',
)

interface Row {
  txHash: string
  buyer: Address
  gross: bigint
  usd8: bigint
  block: bigint
}

/** Truncate an address for display. */
function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Human "updated Ns ago" / "updated Nm ago" from a millisecond timestamp. */
function updatedAgo(updatedAt: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - updatedAt) / 1000))
  if (secs < 60) return `updated ${secs}s ago`
  return `updated ${Math.floor(secs / 60)}m ago`
}

/**
 * Merchant receipt feed: the last 50 PaymentReceived events for the merchantId
 * stored at onboard time (localStorage), filtered by merchantId. Minimal:
 * block, amount, USD, buyer. Rendered client-only (route wrapper, ssr: false).
 */
export function DashboardView(): ReactNode {
  const chainId = getDefaultChainId()
  const { primaryWallet } = useDynamicContext()
  const tenantId = primaryWallet?.address?.toLowerCase()

  const [merchantId, setMerchantId] = useState<bigint | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  // True once we've checked BOTH sources for a merchant id; gates the
  // register-step vs dead-end copy so neither flashes during the async load.
  const [merchantResolved, setMerchantResolved] = useState(false)
  // The tenant has a branding row but is not yet on-chain — show the
  // "Switch on payments" card (mounts RegisterForm). Null until resolved.
  const [hasBranding, setHasBranding] = useState(false)
  // The just-registered result, so the card can flip to a "payments on"
  // confirmation (LinkCard) without a full reload.
  const [justRegistered, setJustRegistered] = useState<RegisterResult | null>(null)

  // Resolve the merchant id from BOTH sources, PREFERRING the durable branding
  // row (`branding.merchantId`) over the per-browser localStorage cache so a
  // merchant who switched on payments elsewhere still sees their receipts here.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let local: string | null = null
      try {
        local = localStorage.getItem('ax1_merchant_id')
      } catch {
        // ignore — private mode / disabled storage
      }
      let fromBranding: string | null = null
      let brandingExists = false
      if (tenantId) {
        const row = await loadBranding(tenantId)
        if (cancelled) return
        if (row) {
          brandingExists = true
          fromBranding = row.merchantId
        }
      }
      const resolved = resolveMerchantId(fromBranding, local)
      if (cancelled) return
      setHasBranding(brandingExists)
      if (resolved) {
        try {
          setMerchantId(BigInt(resolved))
        } catch {
          // ignore a malformed id
        }
      }
      setMerchantResolved(true)
    })()
    return () => {
      cancelled = true
    }
  }, [tenantId])

  // Wire RegisterForm → attach the new merchantId server-side (the slug becomes
  // payable), cache it locally, and flip the card to the live confirmation.
  const handleRegistered = useCallback(
    async (result: RegisterResult): Promise<void> => {
      const id = result.merchantId.toString()
      if (tenantId) {
        // Make the slug PAYABLE: bind the merchantId to the branding row.
        await attachOnChain({ tenantId, merchantId: id })
      }
      try {
        localStorage.setItem('ax1_merchant_id', id)
      } catch {
        // ignore — the branding row is the durable source of truth
      }
      setMerchantId(result.merchantId)
      setJustRegistered(result)
    },
    [tenantId],
  )

  const load = useCallback(async () => {
    if (merchantId === null) return
    setLoading(true)
    setError(null)
    try {
      const routerAddress = getRouterAddress(chainId)
      const client = getPublicClient(chainId)
      const logs = await client.getLogs({
        address: routerAddress,
        event: PAYMENT_RECEIVED_EVENT,
        args: { merchantId },
        fromBlock: 'earliest',
        toBlock: 'latest',
      })
      const mapped: Row[] = logs
        .slice(-50)
        .reverse()
        .map((log) => ({
          txHash: log.transactionHash,
          buyer: log.args.buyer as Address,
          gross: log.args.grossAmount as bigint,
          usd8: log.args.usdAmount8 as bigint,
          block: log.blockNumber,
        }))
      setRows(mapped)
      setLastUpdated(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load receipts.')
    } finally {
      setLoading(false)
    }
  }, [chainId, merchantId])

  useEffect(() => {
    void load()
  }, [load])

  // Tick once a second so the "updated Ns ago" label stays current.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (lastUpdated === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [lastUpdated])

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Dashboard</h1>
        <ConnectButton />
      </header>

      {/* Get Super Verified — the visible entry point to the /verify journey. */}
      <a
        href="/verify"
        className="flex items-center justify-between gap-4 rounded-2xl border border-rail/30 bg-rail/5 px-5 py-4 transition-colors hover:bg-rail/10"
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-ink">Get Super Verified</span>
          <span className="text-xs text-neutral-500">
            Prove you&apos;re real — add checks, then finish with the World ID scan to reach the
            highest trust tier.
          </span>
        </span>
        <span className="shrink-0 rounded-lg bg-rail px-3 py-1.5 text-sm font-medium text-white">
          Verify →
        </span>
      </a>

      {/* Settled balance + withdraw (Circle Gateway). Self-hides if the deployment has no Gateway. */}
      <GatewayBalanceCard />

      {merchantId !== null ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          {lastUpdated !== null ? (
            <span className="text-xs text-neutral-400">{updatedAgo(lastUpdated, now)}</span>
          ) : null}
        </div>
      ) : null}

      {justRegistered ? (
        // Just switched on payments — show the live link/QR/embed confirmation.
        <div className="rounded-2xl border border-green-200 bg-green-50/40 p-6">
          <p className="mb-4 text-sm font-medium text-green-700">
            ✓ Payments are on. Your checkout link is live.
          </p>
          <LinkCard result={justRegistered} />
        </div>
      ) : merchantId === null ? (
        !merchantResolved ? (
          <div className="h-24 animate-pulse rounded-xl bg-neutral-100" />
        ) : hasBranding ? (
          // Branding saved but not yet on-chain — mount the one-time register
          // step HERE (the onboard done screen points the merchant to it). On
          // success it attaches the merchantId so the slug becomes payable.
          <section className="flex flex-col gap-4 rounded-2xl border border-rail/30 bg-rail/5 p-6">
            <div>
              <h2 className="text-lg font-semibold text-ink">Switch on payments</h2>
              <p className="text-sm text-neutral-500">
                Your branded checkout is ready. Finish the quick one-time on-chain setup to start
                accepting USDC — no further steps after this.
              </p>
            </div>
            <RegisterForm onRegistered={(r) => void handleRegistered(r)} />
          </section>
        ) : (
          <p className="text-sm text-neutral-500">
            No merchant found in this browser.{' '}
            <a href="/onboard" className="text-rail underline-offset-2 hover:underline">
              Set up your checkout on the onboard page
            </a>{' '}
            first.
          </p>
        )
      ) : (
        <>
          <p className="text-sm text-neutral-500">Merchant #{merchantId.toString()}</p>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          {loading ? (
            <div className="h-32 animate-pulse rounded-xl bg-neutral-100" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-neutral-500">No payments yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-neutral-500">
                  <th className="py-2 font-medium">Block</th>
                  <th className="py-2 font-medium">Received (USDC)</th>
                  <th className="py-2 font-medium">USD</th>
                  <th className="py-2 font-medium">Buyer</th>
                  <th className="py-2 font-medium">Tx</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.txHash}-${r.buyer}`} className="border-b border-neutral-100">
                    <td className="py-2 font-mono text-xs">{r.block.toString()}</td>
                    <td className="py-2">{formatTokenAmount(r.gross, tokenDecimalsFor(chainId))}</td>
                    <td className="py-2">${amount8ToUsd(r.usd8)}</td>
                    <td className="py-2 font-mono text-xs">{short(r.buyer)}</td>
                    <td className="py-2 font-mono text-xs">
                      <TxHashLink
                        chainId={chainId}
                        hash={r.txHash}
                        className="font-mono text-xs text-rail underline-offset-2 hover:underline"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  )
}
