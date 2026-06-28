# Examples — real, runnable Access0x1 flows

Four copy-paste demos, each a **standalone script or page** that runs against the
**live testnet deployment** — no contracts to write, no monorepo to clone. Every
one points at the **CREATE3 mirror** addresses (the same on every mirrored chain)
straight from the README [Deployments](../README.md#deployments) table, and every
USD price is converted to a token amount **in-transaction** by the router's
Chainlink feed.

| Example | What it shows | Spine it composes |
| --- | --- | --- |
| [`coffee-shop-usd-payment`](./coffee-shop-usd-payment) | A one-coffee, USD-priced checkout: quote `$4.50` → pay in USDC → `net + fee == gross`, zero custody. | [`Access0x1Router`](../src/Access0x1Router.sol) |
| [`subscription-tier-checkout`](./subscription-tier-checkout) | A "Pro" plan: sign a budget-scoped [`SessionGrant`](../src/SessionGrant.sol) once, then auto-renew with no per-charge prompt. | [`Access0x1Subscriptions`](../src/Access0x1Subscriptions.sol) + `SessionGrant` |
| [`nft-marketplace`](./nft-marketplace) | List an ERC-721 at a USD price; a buyer pays a token and the NFT transfers **atomically** in the same tx. | [`Access0x1Nft`](../src/Access0x1Nft.sol) |
| [`merchant-webhook-handler`](./merchant-webhook-handler) | Consume the [Chainlink CRE](../cre) "Notified Settlement" audit stream — verify the bearer token, ack each settlement once. | [`Access0x1Receiver`](../src/Access0x1Receiver.sol) + [`cre/`](../cre) |

## Addresses these examples use

All four read the **same mirror set**, published once in
[`script/mirror-manifest.json`](../script/mirror-manifest.json) and shown in the
README [Deployments](../README.md#deployments) table. The links below go to **Base
Sepolia** (chain id `84532`), one of the mirrored chains — the addresses are
**identical on every chain the mirror is live on**, so the same script runs on Arc,
Optimism Sepolia, Arbitrum Sepolia, and the rest without an address change.

| What | Address |
| --- | --- |
| `Access0x1Router` | `0xe92244e3368561faf21648146511DeDE3a475EB5` |
| `Access0x1Subscriptions` | `0x787D2d97F7b0B0A7aFE1eCD97032912fefE8e0ba` |
| `SessionGrant` | `0xf84fEA541939f3683893530101Fe77d05c390C9d` |
| `Access0x1Nft` | `0x9625bEc5e2eD53B48e4CbcbBbe9287C00db31178` |
| `Access0x1Receiver` | `0xA365aEC97a582e521e5d5444C2930E96B59AD215` |
| USDC (Base Sepolia, Circle) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

> **Always re-confirm an address on the explorer before pointing real value at it**
> (LAW #4 — an address that isn't on-chain isn't claimed). The single source of truth
> is the README table and [`web/lib/deployments.ts`](../web/lib/deployments.ts), which
> is regenerated from each chain's committed `broadcast/` record — never hand-entered.
> These are **testnet-only** deployments; there is no mainnet deploy.

## USD-8 fixed point

Every `usdAmount8` is a USD value with **8 decimals**, matching the router's
`quote`: `$4.50` is `450_000_000`, `$29.00` is `2_900_000_000`. The TypeScript
examples convert a human dollar number for you; the diagrams spell the math out.

## Running them

| Example | Stack | Command |
| --- | --- | --- |
| `coffee-shop-usd-payment` | Node + [viem](https://viem.sh) | `node pay.mjs` |
| `subscription-tier-checkout` | Node + viem | `node subscribe.mjs` |
| `nft-marketplace` | Node + viem | `node list-and-buy.mjs` |
| `merchant-webhook-handler` | Node (`http`, zero deps) | `node server.mjs` |

The first three need a funded testnet key in `PRIVATE_KEY` (a fresh dev wallet —
never a key with real value) and read the chain from `RPC_URL`. The webhook handler
needs no key — it is the server the [CRE workflow](../cre) calls. Each folder's
README has the exact prerequisites and the before/after value-flow diagram.

## Where these fit

- New to the stack? Read [GETTING-STARTED](../docs/GETTING-STARTED.md) first — the
  60-second mental model and the React `<PayButton>` path.
- The contract signatures these scripts call, verbatim: [RECIPES](../docs/RECIPES.md).
- Want a whole app scaffolded, not a script? [`templates/starter`](../templates/starter)
  (`npx degit Access0x1/Access0x1/templates/starter my-checkout`).
