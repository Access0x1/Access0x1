'use client'

import type { ReactNode } from 'react'
import type { PayTokenSymbol, ResolvedPayToken } from '@/lib/tokens'

/**
 * TokenPicker — the buyer chooses WHICH allowlisted coin to pay in.
 *
 * Renders the full pay-token menu (USDC, WETH, LINK, UNI, ENS, DAI, WBTC) for the
 * active chain. A token that is NOT configured on this chain (no env address) is
 * shown DISABLED with an honest "not available on this chain" note — never hidden,
 * never invented (law #4 truth-in-copy; doctrine guardrail #5 no guessed address).
 *
 * The picker is OFF the money path: it only sets which token the parent
 * CheckoutCard quotes + pays in. USDC stays the default selection.
 */
export function TokenPicker({
  tokens,
  selected,
  onSelect,
  disabled = false,
}: {
  /** The resolved pay-token set for the active chain (USDC first). */
  tokens: readonly ResolvedPayToken[]
  /** The currently selected symbol. */
  selected: PayTokenSymbol
  /** Called with the new symbol when the buyer picks an AVAILABLE token. */
  onSelect: (symbol: PayTokenSymbol) => void
  /** Lock the whole picker (e.g. while a payment is confirming). */
  disabled?: boolean
}): ReactNode {
  return (
    <div className="flex flex-col gap-2" data-testid="token-picker">
      <p className="text-sm font-medium text-neutral-600">Pay with</p>
      <div role="radiogroup" aria-label="Pay-in token" className="grid grid-cols-2 gap-2">
        {tokens.map((t) => {
          const isSelected = t.symbol === selected
          const isDisabled = disabled || !t.available
          return (
            <button
              key={t.symbol}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-disabled={isDisabled}
              disabled={isDisabled}
              data-symbol={t.symbol}
              data-available={t.available}
              data-selected={isSelected}
              onClick={() => {
                if (!t.available || disabled) return
                onSelect(t.symbol)
              }}
              title={t.available ? `${t.name} (${t.symbol})` : `${t.symbol} not available on this chain`}
              className={[
                'flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
                isSelected
                  ? 'border-rail bg-rail/5 ring-1 ring-rail'
                  : 'border-neutral-200 hover:border-neutral-300',
                isDisabled ? 'cursor-not-allowed opacity-50 hover:border-neutral-200' : 'cursor-pointer',
              ].join(' ')}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-semibold text-ink">{t.symbol}</span>
                {isSelected ? <span className="text-xs text-rail">Selected</span> : null}
              </span>
              <span className="text-xs text-neutral-500">{t.name}</span>
              {!t.available ? (
                <span className="text-[11px] text-neutral-400">not available on this chain</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
