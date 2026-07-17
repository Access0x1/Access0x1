import { DeploymentsView } from '@access0x1/web'

// app/deployments/page.tsx: `<DeploymentsView />` — the owner's on-chain
// code-diff console, zero props. Every row comes from the real, committed
// `lib/deployments.ts` (generated from broadcast/) and a live per-chain
// `getCode` read against each chain's public RPC — there is nothing to
// configure from the outside; one story cell covers the whole component.
export const Default = () => <DeploymentsView />
