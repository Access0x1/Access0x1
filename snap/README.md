# Access0x1 MetaMask Snap — readable payment insight

**Know what you're paying before you sign.** This [MetaMask Snap](https://docs.metamask.io/snaps/)
renders a human-readable insight panel for [`Access0x1Router`](../src/Access0x1Router.sol) payments
inside the wallet's transaction-confirmation flow. Instead of blind calldata, a customer paying for a
booking sees **"Pay $29.00 to merchant #7"** — merchant name and branding included — before they
approve.

It is the wallet-side complement to the [clear-signing](../clear-signing/README.md) descriptors:
clear-signing makes the transaction readable on a hardware wallet; this Snap makes it readable inside
MetaMask itself, and adds dapp-invokable read methods (config, payment history, last receipt).

```
MetaMask tx confirmation
        │
        ▼
   onTransaction  ──▶ parse Access0x1Router call ──▶ insight panel
                                                     (merchant name, amount, order)
   onRpcRequest   ──▶ configure / setMerchantBranding / getRouterConfig /
                      getPaymentHistory / getLastPaymentReceipt
```

## Doctrine

- **No keys, no funds (doctrine #1).** The Snap is read/display only; it never holds or moves value.
- **Router address is never hardcoded (doctrine #7).** The dapp sets it via the `configure` RPC method,
  and it is persisted in encrypted Snap state — so one Snap works across chains and deployments.
- Merchant branding (name, color, logo SVG) is fetched and **sanitized** before render
  (`src/branding/sanitize.ts`) — bounded text lengths, color/SVG validation — so untrusted merchant
  metadata can't inject markup into the wallet UI.

## Layout

| Path | What it is |
|------|------------|
| `src/index.ts` | Entry point — exports `onTransaction` and `onRpcRequest` handlers. |
| `src/router/` | Decode an `Access0x1Router` call + resolve the merchant name. |
| `src/branding/` | Fetch, sanitize, and store per-merchant branding. |
| `src/ui/`, `src/payout/` | Insight-panel rendering + private-payout helpers. |
| `src/state.ts`, `src/types.ts` | Encrypted Snap state + shared types. |
| `snap.manifest.json` | Snap manifest (permissions, source shasum). |

## Develop

```bash
cd snap
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run build       # mm-snap build  → dist/bundle.js
npm run serve       # mm-snap serve  → local Snap for MetaMask Flask
```

Requires [MetaMask Flask](https://docs.metamask.io/snaps/get-started/install-flask/) to install the
local build. Permissions requested are in `snap.manifest.json`
(`transaction-insight`, `rpc`, `dialog`, `manageState`, `network-access`, `ethereum-provider`).

## Status

Build + local-serve scaffold (not published). The published package id is `@access0x1/snap`; on-device
testing is via `npm run serve` against MetaMask Flask.
