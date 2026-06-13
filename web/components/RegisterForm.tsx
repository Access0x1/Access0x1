'use client'

import { useState, type FormEvent, type ReactNode } from 'react'
import { isAddress, keccak256, toHex, type Address, type Hash } from 'viem'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { getDefaultChainId, getRouterAddress } from '@/lib/chains'
import { registerMerchant } from '@/lib/contracts'
import { getPublicClient, getWalletClient } from '@/lib/wallet'

export interface RegisterResult {
  merchantId: bigint
  txHash: Hash
  name: string
  priceUsd: string
  chainId: number
}

/**
 * Onboarding form: business name + USD price (+ optional fee recipient) ->
 * `registerMerchant(payout = connected address, feeRecipient, feeBps = 0,
 * nameHash = keccak256(name))`. On success it hands the result up to the page,
 * which renders the link/QR/snippet card. The typed name is stored client-side
 * (the on-chain record holds only the nameHash commitment).
 */
export function RegisterForm({
  onRegistered,
}: {
  onRegistered: (result: RegisterResult) => void
}): ReactNode {
  const { primaryWallet } = useDynamicContext()
  const [name, setName] = useState('')
  const [priceUsd, setPriceUsd] = useState('29.00')
  const [feeRecipient, setFeeRecipient] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)

    if (!primaryWallet) {
      setError('Connect a wallet first.')
      return
    }
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Enter a business name.')
      return
    }
    const price = Number(priceUsd)
    if (!Number.isFinite(price) || price <= 0) {
      setError('Enter a valid USD price greater than 0.')
      return
    }
    if (feeRecipient && !isAddress(feeRecipient)) {
      setError('Fee recipient must be a valid address.')
      return
    }

    const chainId = getDefaultChainId()
    let routerAddress: Address
    try {
      routerAddress = getRouterAddress(chainId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Router not configured for this chain.')
      return
    }

    setSubmitting(true)
    try {
      const walletClient = await getWalletClient(primaryWallet)
      const publicClient = getPublicClient(chainId)
      const payout = walletClient.account?.address as Address

      const { merchantId, txHash } = await registerMerchant(
        walletClient,
        publicClient,
        routerAddress,
        {
          payout,
          feeRecipient: (feeRecipient || '0x0000000000000000000000000000000000000000') as Address,
          feeBps: 0,
          nameHash: keccak256(toHex(trimmedName)),
        },
      )

      onRegistered({
        merchantId,
        txHash,
        name: trimmedName,
        priceUsd: price.toFixed(2),
        chainId,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Business name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Coffee"
          className="rounded-lg border border-neutral-300 px-3 py-2 outline-none focus:border-rail"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Price (USD)</span>
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={priceUsd}
          onChange={(e) => setPriceUsd(e.target.value)}
          className="rounded-lg border border-neutral-300 px-3 py-2 outline-none focus:border-rail"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">
          Fee recipient <span className="text-neutral-400">(optional)</span>
        </span>
        <input
          type="text"
          value={feeRecipient}
          onChange={(e) => setFeeRecipient(e.target.value)}
          placeholder="0x… (defaults to your payout)"
          className="rounded-lg border border-neutral-300 px-3 py-2 font-mono text-sm outline-none focus:border-rail"
        />
      </label>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <button
        type="submit"
        disabled={submitting || !primaryWallet}
        className="rounded-lg bg-rail px-4 py-2.5 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Registering…' : 'Create payment link'}
      </button>
    </form>
  )
}
