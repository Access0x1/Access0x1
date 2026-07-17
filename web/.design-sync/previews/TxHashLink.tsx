import { TxHashLink } from '@access0x1/web'

// components/LinkCard.tsx / ContractPanel.tsx / SponsorPanel.tsx / DashboardView.tsx's
// real pattern: a chain WITH a verifiable explorer (Base Sepolia) renders a
// shortened, clickable link.
export const Linked = () => (
  <TxHashLink
    chainId={84532}
    hash="0xc3720996289407df2a37535bd9df6c9a2c16c853252df7405d0f47e51ff81e50"
  />
)

// components/ReceiptScreen.tsx's real pattern: Arc (the flagship gas-free
// settlement chain) has no verifiable explorer, so `full` renders the whole
// hash as selectable monospace text — never an invented or broken link (law #4).
export const FullNoExplorer = () => (
  <TxHashLink
    chainId={5042002}
    hash="0x2538d86dadb9f4b70661348e639291fd0e9f008d1f1ef7c707b917ae46ec3291"
    full
  />
)

// The same no-explorer chain without `full` — the shortened text default,
// e.g. components/journey/SellableForms.tsx's compact inline usage.
export const ShortNoExplorer = () => (
  <TxHashLink
    chainId={5042002}
    hash="0x1becd0a33af8ca090b6094def484d5dcfbd5218293d33e0eed2452c193341993"
  />
)
