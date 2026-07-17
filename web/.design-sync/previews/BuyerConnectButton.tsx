import { BuyerConnectButton } from '@access0x1/web'

// components/CheckoutCard.tsx's disconnected fallback: the BUYER's own plain-
// wagmi connect control (never Dynamic — a shopper paying at checkout must
// never be metered as a Dynamic MAU). This static preview has no browser
// wallet extension, so wagmi's EIP-6963 discovery finds zero connectors —
// the same "Connect wallet" state a visitor without MetaMask/Rabby/etc. sees
// before any wallet is installed (component still renders its real button,
// just with nothing to connect to yet).
export const Default = () => <BuyerConnectButton />

// The real composition from CheckoutCard.tsx (the "no wallet yet" branch,
// lines 573-577): the helper line stacked above the button.
export const InCheckoutContext = () => (
  <div className="flex flex-col gap-2" style={{ maxWidth: 320 }}>
    <p className="text-sm text-neutral-500">Connect a wallet to pay.</p>
    <BuyerConnectButton />
  </div>
)
