import { RailModulesCard } from '@access0x1/web'

// components/pages/DashboardView.tsx's real post-registration composition:
// <RailModulesCard chainId={justRegistered.chainId} merchantId={justRegistered.merchantId.toString()} />.
// `sharedModulesFor`/`moduleExplorerUrl` read lib/deployments.ts's generated,
// broadcast-derived module list directly (no env needed) — so these fixtures
// resolve REAL deployment addresses, not invented ones.

// Base Sepolia (84532): a known explorer, so each module address is a live
// basescan link.
export const Default = () => (
  <div style={{ maxWidth: 380 }}>
    <RailModulesCard chainId={84532} merchantId="3" />
  </div>
)

// Arc (5042002): deployed modules exist, but Arc has no recorded block
// explorer, so each address renders as plain monospace text (never an
// invented link — RailModulesCard.tsx's moduleExplorerUrl fallback).
export const NoExplorerChain = () => (
  <div style={{ maxWidth: 380 }}>
    <RailModulesCard chainId={5042002} merchantId="12" />
  </div>
)

// Polygon Amoy (80002): a supported chain with no recorded deployments yet
// (not in lib/deployments.ts) — the honest empty state, never a guessed
// module list.
export const NoDeployments = () => (
  <div style={{ maxWidth: 380 }}>
    <RailModulesCard chainId={80002} merchantId="7" />
  </div>
)
