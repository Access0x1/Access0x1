'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { getAuthToken, useDynamicContext } from '@dynamic-labs/sdk-react-core'

/** The deployment's Circle Gateway balance — both legs as 6-decimal USDC strings. */
interface Balance {
  gateway: string
  wallet: string
}

/**
 * Testnet payout destinations. Each `key` MUST exist in the SDK's `GATEWAY_DOMAINS`
 * (the withdraw route rejects anything else with a 400).
 */
const DESTINATIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'arcTestnet', label: 'Arc Testnet' },
  { key: 'baseSepolia', label: 'Base Sepolia' },
  { key: 'optimismSepolia', label: 'Optimism Sepolia' },
  { key: 'polygonAmoy', label: 'Polygon Amoy' },
  { key: 'avalancheFuji', label: 'Avalanche Fuji' },
  { key: 'sepolia', label: 'Ethereum Sepolia' },
]

/** Render a "5.000000" USDC string as a friendlier "5.00". */
function fmtUsdc(s: string): string {
  const n = Number(s)
  if (!Number.isFinite(n)) return '0.00'
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}

/** Truncate an address for the confirm line. */
function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

/**
 * Settled-balance + withdraw card for the merchant dashboard.
 *
 * READ leg (informational, no auth): GET /api/gateway/balance → the deployment's
 * Circle Gateway available balance + payout-wallet USDC. Fail-soft by design — if the
 * deployment has no Gateway configured (the route 500s on an unset SELLER_ADDRESS),
 * the whole card hides itself rather than showing a broken zero.
 *
 * WITHDRAW leg (money movement, auth-gated): POST /api/gateway/withdraw with the
 * caller's Dynamic JWT (and the connected wallet as the booth-fallback tenantId). The
 * server only lets the deployment's own payout wallet (SELLER_ADDRESS) withdraw its
 * balance — any other wallet gets a clear, friendly 403. A confirm step guards the
 * irreversible transfer, and the resulting mint tx hash is shown on success. The card
 * NEVER moves funds itself: it calls the authenticated server endpoint, which holds the
 * key and does the balance pre-check + transfer.
 */
export function GatewayBalanceCard(): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const [bal, setBal] = useState<Balance | null>(null)
  const [configured, setConfigured] = useState(true)
  const [open, setOpen] = useState(false)

  const [amount, setAmount] = useState('')
  const [dest, setDest] = useState<string>(DESTINATIONS[0].key)
  const [recipient, setRecipient] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string; tx?: string } | null>(null)

  const loadBalance = useCallback(async () => {
    try {
      const res = await fetch('/api/gateway/balance')
      if (!res.ok) {
        setConfigured(false)
        return
      }
      setBal((await res.json()) as Balance)
    } catch {
      setConfigured(false)
    }
  }, [])

  useEffect(() => {
    void loadBalance()
  }, [loadBalance])

  // Default the recipient to the connected wallet (the common case: withdraw to self).
  useEffect(() => {
    if (primaryWallet?.address && recipient === '') setRecipient(primaryWallet.address)
  }, [primaryWallet?.address, recipient])

  // Any field edit invalidates a pending confirmation, so you always confirm the
  // exact values you're about to send.
  const onEdit = useCallback((setter: (v: string) => void) => {
    return (v: string) => {
      setter(v)
      setConfirming(false)
      setResult(null)
    }
  }, [])

  const submitWithdraw = useCallback(async () => {
    setSubmitting(true)
    setResult(null)
    try {
      const token = getAuthToken()
      const res = await fetch('/api/gateway/withdraw', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          amount: amount.trim(),
          destinationChain: dest,
          recipient: recipient.trim(),
          tenantId: primaryWallet?.address ?? '',
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { mintTxHash?: string; error?: string }
      if (res.ok && data.mintTxHash) {
        setResult({ ok: true, msg: 'Withdrawal submitted. Mint tx:', tx: data.mintTxHash })
        setConfirming(false)
        setAmount('')
        void loadBalance()
      } else if (res.status === 401 || res.status === 403) {
        setResult({
          ok: false,
          msg: 'Only this deployment’s payout wallet can withdraw. Connect that wallet and try again.',
        })
      } else {
        setResult({ ok: false, msg: data.error ?? 'Withdrawal failed. Please try again.' })
      }
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : 'Withdrawal failed.' })
    } finally {
      setSubmitting(false)
    }
  }, [amount, dest, recipient, primaryWallet?.address, loadBalance])

  // No Gateway on this deployment → render nothing (fail-soft, no broken zero card).
  if (!configured) return null

  const destLabel = DESTINATIONS.find((d) => d.key === dest)?.label ?? dest

  return (
    <section className="rounded-2xl border border-neutral-200 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-500">Settled balance (Circle Gateway)</h2>
        <button
          type="button"
          onClick={() => void loadBalance()}
          className="text-xs text-neutral-400 hover:text-neutral-600"
        >
          refresh
        </button>
      </div>

      <div className="mt-2 flex items-baseline gap-6">
        <div>
          <div className="text-2xl font-semibold text-ink">${bal ? fmtUsdc(bal.gateway) : '—'}</div>
          <div className="text-xs text-neutral-400">available to withdraw</div>
        </div>
        <div>
          <div className="text-sm text-neutral-600">${bal ? fmtUsdc(bal.wallet) : '—'}</div>
          <div className="text-xs text-neutral-400">payout wallet</div>
        </div>
      </div>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
        >
          Withdraw…
        </button>
      ) : (
        <div className="mt-4 flex flex-col gap-3 border-t border-neutral-100 pt-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Amount (USDC)</span>
            <input
              value={amount}
              onChange={(e) => onEdit(setAmount)(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="rounded-lg border border-neutral-300 px-3 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Destination chain</span>
            <select
              value={dest}
              onChange={(e) => onEdit(setDest)(e.target.value)}
              className="rounded-lg border border-neutral-300 px-3 py-1.5"
            >
              {DESTINATIONS.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">Recipient address</span>
            <input
              value={recipient}
              onChange={(e) => onEdit(setRecipient)(e.target.value)}
              placeholder="0x…"
              className="rounded-lg border border-neutral-300 px-3 py-1.5 font-mono text-xs"
            />
          </label>

          {!confirming ? (
            <button
              type="button"
              disabled={amount.trim() === '' || recipient.trim() === ''}
              onClick={() => setConfirming(true)}
              className="rounded-lg bg-rail px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Review withdrawal
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <p className="text-amber-900">
                Withdraw <strong>${amount} USDC</strong> to {destLabel} at{' '}
                <span className="font-mono text-xs">{shortAddr(recipient)}</span>. This moves funds and
                can’t be undone.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void submitWithdraw()}
                  className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {submitting ? 'Withdrawing…' : 'Confirm withdrawal'}
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setConfirming(false)}
                  className="rounded-lg border border-neutral-300 px-4 py-2 text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {result ? (
            <p className={`text-sm ${result.ok ? 'text-green-700' : 'text-red-600'}`}>
              {result.msg}{' '}
              {result.tx ? <span className="font-mono text-xs break-all">{result.tx}</span> : null}
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}
