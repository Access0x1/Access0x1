import { useState } from 'react'
import { TokenPicker } from '@access0x1/web'

// TokenPicker is a pure presentational leaf — CheckoutCard.tsx feeds it
// `resolvePayTokens(chainId)` (lib/tokens.ts), env-resolved per chain. This
// static bundle has no NEXT_PUBLIC_TOKEN_* env to resolve against, so the
// fixture below is composed by hand from the SAME canonical token set
// (lib/tokens.ts's SUPPORTED_PAY_TOKENS: symbol/name/decimals) with a
// realistic partial-rollout availability split — USDC/WETH/LINK configured,
// UNI/ENS/DAI/WBTC not yet wired on this chain — exactly the "some coins
// live, some pending" state a real chain shows mid-rollout (never all-on,
// never all-off, never invented symbols).
const TOKENS = [
  { symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', feed: '0x0153dc9b8b4f5f2f8db6c1a54a0e2d4c4f3a1b7e2', available: true },
  { symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, address: '0x4200000000000000000000000000000000000006', feed: '0x4adc67696ba383f43dd60a9e78f2c97fbbfc7cb1', available: true },
  { symbol: 'LINK', name: 'Chainlink', decimals: 18, address: '0xe4ab69c077896252fafbd49efd26b5d171a32410', feed: '0x0fb99723aee6f420bead13e6bbb79b7e6f034298', available: true },
  { symbol: 'UNI', name: 'Uniswap', decimals: 18, address: undefined, feed: undefined, available: false },
  { symbol: 'ENS', name: 'Ethereum Name Service', decimals: 18, address: undefined, feed: undefined, available: false },
  { symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, address: undefined, feed: undefined, available: false },
  { symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, address: undefined, feed: undefined, available: false },
]

// USDC selected (the default every checkout opens on).
export const UsdcSelected = () => {
  const [selected, setSelected] = useState('USDC')
  return <TokenPicker tokens={TOKENS} selected={selected} onSelect={setSelected} />
}

// The buyer picked a different AVAILABLE coin — proves the selection ring
// moves and isn't hardcoded to USDC.
export const WethSelected = () => {
  const [selected, setSelected] = useState('WETH')
  return <TokenPicker tokens={TOKENS} selected={selected} onSelect={setSelected} />
}

// Locked while a payment is confirming (CheckoutCard passes `disabled={paying}`).
export const Disabled = () => (
  <TokenPicker tokens={TOKENS} selected="USDC" onSelect={() => {}} disabled />
)
