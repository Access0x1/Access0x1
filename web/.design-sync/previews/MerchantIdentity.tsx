import { MerchantIdentity } from '@access0x1/web'

// components/CheckoutCard.tsx's real usage: <MerchantIdentity payout={merchant.payout}
// chainId={chainId} />. The safe default (truncated address) renders immediately
// and stays the honest fallback here — this static preview has no real Mainnet
// RPC to complete the ENSIP-19 forward==reverse check, which is exactly the
// fail-soft path the component is built to land on (law #4: never fabricate a name).
export const Default = () => (
  <MerchantIdentity payout="0x7d3a48269416507e6d207a9449e7800971823ffa" chainId={84532} />
)

// The same "who am I paying" line settling on Arc — the flagship gas-free chain.
export const ArcTestnet = () => (
  <MerchantIdentity payout="0xccbaadb3281e55fe42b90414231112b37775450e" chainId={5042002} />
)
