import { MerchantIdentityView } from '@access0x1/web'

// The verified-name state — an ENSIP-19 forward==reverse pass, styled per the
// project's own subname convention (Chain facts: "ENS: merchant.access0x1.eth").
export const Verified = () => (
  <MerchantIdentityView
    payout="0x7d3a48269416507e6d207a9449e7800971823ffa"
    name="merchant.access0x1.eth"
  />
)

// The safe default — no verified name (unconfigured resolver, RPC off, or no
// forward==reverse match) — falls back to the truncated payout address, per
// components/CheckoutCard.tsx's real "who am I paying" line.
export const AddressFallback = () => (
  <MerchantIdentityView payout="0xccbaadb3281e55fe42b90414231112b37775450e" name={null} />
)
