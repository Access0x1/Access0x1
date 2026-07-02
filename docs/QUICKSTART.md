<!--
  QUICKSTART — the 5-minute developer onboarding for Access0x1.

  This is the "one link, no contract code" promise made real: three integration
  paths (React SDK · one-tag embed.js · hosted no-code link), every snippet
  copy-pasteable and grounded in the shipped API surface (packages/react/src,
  web/public/embed.js, web/app/{m,c,onboard}). Addresses are NOT restated by
  hand — they are quoted from the canonical homes (README "Deployments" table +
  docs/CHAIN-ADDRESSES.md) so this file never drifts into a second source of
  truth for an address (law #4: an address that isn't on-chain isn't claimed).

  Owned by the Developer Advocate. New file — does not modify any other docs/*.md.
-->

# Quickstart — accept crypto in 5 minutes, no contract code

Access0x1 is **one shared, multi-tenant, zero-custody payments router** (`Access0x1Router`)
already live on testnet. You never deploy a contract, never custody funds, and never write
Solidity. You register once to get a `merchantId`, then point any of three drop-ins at the
deployed router on your settlement chain. Every payment is a **single on-chain transaction**:
buyer → router → your payout wallet **+** the platform treasury, settled in the same block,
priced USD→token by a Chainlink feed read *inside the pay tx*.

Pick the path that matches your stack:

| Path | Who it's for | Time | Build step? | Example use-case |
| --- | --- | --- | --- | --- |
| [1. React SDK (`@access0x1/react`)](#1--react-sdk-access0x1react) | React / Next.js apps | ~5 min | yes (npm) | Add checkout to your Next.js app |
| [2. One-tag `embed.js`](#2--one-tag-embedjs-any-html) | Any HTML page, no framework | ~2 min | no | Drop a Buy button on a Shopify / Webflow page |
| [3. Hosted no-code link](#3--hosted-no-code-link) | Non-coders, invoices, QR, bios | ~1 min | none | Share a pay link in a bio or as a QR code |

> **Step 0 — get a `merchantId` (shared by all three paths).** Onboarding is a single
> permissionless `registerMerchant(payout, feeRecipient, feeBps, nameHash)` call on the router
> → it returns your `merchantId`; the caller becomes the merchant owner (see the README
> "Contract surface"). The easiest way is the **hosted onboarding wizard** at `/onboard` on the
> Access0x1 app — connect a wallet, set your payout address + optional surcharge, and it makes
> the call and shows your `merchantId` (and an optional checkout `slug`). You can also call
> `registerMerchant` directly with `cast` / viem if you prefer. You only do this **once per
> business**, on whichever chain(s) you want to settle on.

---

## 1 — React SDK (`@access0x1/react`)

The fastest path for a React or Next.js app. The SDK is **viem/wagmi-native and auth-agnostic** —
it reads your existing viem clients and never holds keys or funds. Wallet/auth (Dynamic, RainbowKit,
plain injected, …) stays entirely the host app's concern.

### Install

Access0x1 is **not published to any npm registry** — you consume `@access0x1/react` straight from
GitHub as a git dependency. Add it to your app's `package.json`:

```jsonc
{
  "dependencies": {
    "@access0x1/react": "github:Access0x1/Access0x1#main"
    // or pin a commit: "github:Access0x1/Access0x1#<sha>"
  }
}
```

Then install as usual (this builds the SDK's `dist/` via its `prepare` script on install):

```bash
npm install   # also add your peers if you haven't: npm install viem wagmi
```

`react`, `viem ^2.35`, and `wagmi ^3` are **peer dependencies** your app already provides
(`wagmi` is optional — you can pass viem clients directly). Nothing else to configure.

> Prefer to vendor it? Copy `packages/react/` into your repo and import from the local path — same
> result, no registry involved.

### Drop in `<PayButton>`

One component, two required business facts — your `merchantId` and the **deployed router address
on your settlement chain** (from the [Deployments](#deployed-routers--the-address-you-point-at)
table below). The integrator never touches a raw token address.

> ⚠️ **The addresses in the snippets below are Base Sepolia examples.** Swap `routerAddress` (and `token`) for **your** settlement chain from [docs/CHAIN-ADDRESSES.md](CHAIN-ADDRESSES.md) / the [Deployments](#deployed-routers--the-address-you-point-at) table before shipping — the router differs per chain. The SDK itself **never** hardcodes an address (LAW #4); you always pass your chain's router in.

```tsx
import { PayButton, clientFromViem } from '@access0x1/react';
import { usePublicClient, useWalletClient } from 'wagmi';

function Checkout() {
  // Your app already provides these (wagmi, or build them from viem directly).
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  // The SDK's client seam — wrap your viem read + write clients.
  const client = clientFromViem(publicClient!, walletClient ?? undefined);

  return (
    <PayButton
      merchantId={42n}                                   // from registerMerchant (bigint)
      usdAmount={29.0}                                   // human USD price
      routerAddress="0xe92244e3368561faf21648146511DeDE3a475EB5" // Base Sepolia router — see Deployments
      client={client}
      onSuccess={(receipt) => console.log('paid', receipt.txHash)}
      onError={(err) => console.error(err.code, err.message)}
    />
  );
}
```

That's the whole integration. The button shows a spinner while quoting + confirming, swaps to an
inline "Paid — view receipt" on success, and renders a typed error message on failure. Style it with
your own `className` (it's a single `<button>`, no modal, no bundled CSS framework).

**Pay in USDC (an ERC-20) instead of native:** pass the `token` prop with the USDC address for that
chain (from [docs/CHAIN-ADDRESSES.md](CHAIN-ADDRESSES.md)). The SDK approves the **exact gross**
(minimum necessary approval) only when your existing allowance is short, then calls `payToken`:

```tsx
<PayButton
  merchantId={42n}
  usdAmount={29.0}
  token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" // Circle USDC on Base Sepolia
  routerAddress="0xe92244e3368561faf21648146511DeDE3a475EB5"
  client={client}
  onSuccess={(receipt) => console.log('paid', receipt.txHash)}
/>
```

#### `<PayButton>` props

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `merchantId` | `bigint` | ✅ | The id from `registerMerchant`. |
| `usdAmount` | `number` | ✅ | Human USD price, e.g. `29.0`. |
| `routerAddress` | `Hex` | ✅ | The deployed `Access0x1Router` on your settlement chain — **never hardcoded by the SDK**, always your prop. |
| `client` | `Access0x1Client` | ✅ | From `clientFromViem(publicClient, walletClient)`. |
| `token` | `Hex` | — | ERC-20 (e.g. USDC) to pay in; omit for native pay. |
| `orderId` | `string` | — | Your human-readable order reference. |
| `label` | `string` | — | Idle-state label. Default `"Pay with Crypto"`. |
| `className` | `string` | — | Your CSS / Tailwind class — full layout control. |
| `onSuccess` | `(receipt) => void` | — | Decoded `PaymentReceipt` (`.txHash`, …). |
| `onError` | `(err) => void` | — | Typed `Access0x1Error` (`.code`, `.message`). |
| `renderSuccess` | `(receipt) => ReactNode` | — | Override the inline success node. |

#### Want your own UI? Use the `usePayment` hook

`<PayButton>` is a thin shell over `usePayment`. Use the hook directly for a custom button, copy, or
layout — you get `quote`, `pay()`, `status`, `txHash`, `receipt`, `error`, and `reset()`. The hook
starts watching `PaymentReceived` *before* it broadcasts, then resolves the receipt safely: it
**binds the watched receipt to this payment's `orderId`** (the event filter can only match the indexed
`merchantId` + buyer, so a concurrent same-buyer/same-merchant payment for a *different* order — e.g. a
second checkout tab — can't resolve the wrong receipt), and it **races the receipt watch against a
120-second timeout** so a missing/undecodable event fails loud instead of hanging the flow forever:

```tsx
import { usePayment, clientFromViem } from '@access0x1/react';
import { usePublicClient, useWalletClient } from 'wagmi';

function PayInUsdc() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const client = clientFromViem(publicClient!, walletClient ?? undefined);

  const { pay, status, quote, txHash, error } = usePayment({
    merchantId: 42n,
    usdAmount: 29.0,
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC on Base Sepolia; omit for native
    routerAddress: '0xe92244e3368561faf21648146511DeDE3a475EB5',
    client,
    onSuccess: (receipt) => console.log('paid', receipt.txHash),
  });

  const busy = status === 'quoting' || status === 'confirm' || status === 'pending';

  return (
    <button onClick={() => void pay()} disabled={busy}>
      {status === 'idle' && 'Pay with Crypto'}
      {busy && 'Confirming…'}
      {status === 'success' && 'Paid'}
      {status === 'error' && error && `Error: ${error.code}`}
    </button>
  );
}
```

**Also exported** (advanced): `useMerchant(routerAddress, merchantId, client)` reads the on-chain
`Merchant` struct (with `isUnregistered()`; never throws on a missing id); `usePaymentLanes(...)`
reads an ERC-6909 lane balance; `CHAINS` / `getChainConfig(chainId)` is the SDK chain registry; and
`ROUTER_ABI` / `ERC20_ABI` / `LANES_ABI` are the raw ABI fragments for fully custom integrations.

---

## 2 — One-tag `embed.js` (any HTML)

No npm, no build step, no framework. Paste **one `<script>` tag** into any HTML page and a
"Pay with Crypto" button appears in place, showing the live USD price. The script makes a single
`eth_call` to read the on-chain quote, then opens the hosted checkout in a new tab on click. It is a
self-contained IIFE that holds **no keys and exports no globals**, and **never crashes the host page** —
every error path falls back to the USD-only label.

```html
<!-- Drop this anywhere on the page. The button renders right after the tag. -->
<script
  src="https://<your-access0x1-host>/embed.js"
  data-merchant="42"
  data-amount-usd="29.00"
  data-chain-id="84532"></script>
```

That's it — `data-merchant` (your `merchantId`) + `data-amount-usd` is the minimum. Clicking opens
`/m/{merchantId}?amount=…&chainId=…` on the same origin the script was served from, where the buyer
connects a wallet and pays.

### White-label by slug

If you registered a checkout **slug** at `/onboard`, use it instead — the embed fetches your public
branding (`/api/branding/{slug}`) and themes the button with your brand color + name, opening the
branded checkout `/c/{slug}`. Branding is best-effort: any failure degrades cleanly to the default
button.

```html
<script
  src="https://<your-access0x1-host>/embed.js"
  data-slug="joes-barbershop"
  data-amount-usd="29.00"
  data-chain-id="84532"></script>
```

### Supported `data-*` attributes

| Attribute | Required | Default | Notes |
| --- | --- | --- | --- |
| `data-merchant` | one of merchant/slug | — | Numeric `merchantId`. Opens `/m/{merchantId}`. |
| `data-slug` | one of merchant/slug | — | Checkout slug (`a-z0-9` + hyphens). Opens branded `/c/{slug}`. |
| `data-amount-usd` | ✅ | — | Decimal USD string, e.g. `"29.00"` (parsed exactly, no float drift). |
| `data-chain-id` | — | `5042002` (Arc) | Settlement chain id. Must be a chain the embed knows; otherwise falls back to the default. |
| `data-label` | — | `"Pay with Crypto"` | Button label. |
| `data-theme` | — | `light` | `light` or `dark`. |
| `data-container` | — | inline | CSS selector to mount the button inside, instead of right after the script tag. |

> **Truth-in-copy:** the default label makes no "instant" or "free" claim. A "no gas fee" label is
> only truthful on a chain where USDC is the native gas token (Arc) — don't claim it elsewhere.

---

## 3 — Hosted no-code link

The purest form of the **"one link, no contract code"** promise — nothing to install at all. After you
register at `/onboard`, you have a hosted checkout URL you can put anywhere a link goes: an email, an
invoice, a QR code, a link-in-bio, a DM. The buyer opens it, connects a wallet, and pays into the same
router.

| You have… | Share this link | Renders |
| --- | --- | --- |
| a `merchantId` | `https://<host>/m/{merchantId}?amount={usdAmount8}&chainId={chainId}` | Standard hosted checkout |
| a branded `slug` | `https://<host>/c/{slug}?amount={usdAmount8}&chainId={chainId}` | Your white-labeled checkout |

- `{usdAmount8}` is the USD price as an **8-decimal integer** (the router's `USD_DECIMALS`): `$29.00` → `2900000000`. Leave `amount` off to let the checkout page collect the amount.
- `{chainId}` is your settlement chain (e.g. `84532` for Base Sepolia, `5042002` for Arc). Omit to use the host's default chain.

Example — a $29.00 checkout link for merchant 42 on Base Sepolia:

```
https://<your-access0x1-host>/m/42?amount=2900000000&chainId=84532
```

Generate a QR from that URL and you have an in-person, no-code, no-app point of sale. The same link
works in an invoice or a "Pay" button on a no-code site builder.

---

## Configuration reference

### React SDK — no config files

The SDK has **no env of its own**. Everything is a component/hook prop: `routerAddress`, `merchantId`,
`usdAmount`, optional `token`, and the `client` you build from your viem public/wallet clients. Keep
the router address and any token addresses in your app's own config/env so a chain swap is one value
change.

### Hosted app / `embed.js` — `NEXT_PUBLIC_*` env

If you self-host the Access0x1 web app (which serves `embed.js` and the hosted checkout), these are the
public, build-time variables it reads (full list + secrets in the repo's `.env.example`). All are safe
to expose — none is a secret:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID` | Default settlement chain when a link/tag omits `chainId`. |
| `NEXT_PUBLIC_ROUTER_ARC` · `NEXT_PUBLIC_ROUTER_BASE_SEPOLIA` · `NEXT_PUBLIC_ROUTER_ZKSYNC_SEPOLIA` | Deployed `Access0x1Router` per chain (also `NEXT_PUBLIC_ROUTER_ADDRESS_<chainId>`). |
| `NEXT_PUBLIC_ARC_RPC_URL` · `NEXT_PUBLIC_RPC_URL_<chainId>` | Read RPC per chain (the embed's `eth_call` quote). |
| `NEXT_PUBLIC_TOKEN_<SYM>_<chainId>` · `NEXT_PUBLIC_TOKEN_<SYM>_FEED_<chainId>` | Allowlisted pay-in tokens + their Chainlink feeds (DAI/LINK/UNI/WBTC/ENS supported). |
| `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` | Dynamic wallet/auth environment for the hosted checkout. |
| `NEXT_PUBLIC_PAYMASTER_URL` · `NEXT_PUBLIC_PAYMASTER_CHAIN_ID` | Optional ERC-7677 gas sponsorship (blank ⇒ off). |

> The `embed.js` shipped in `web/public/embed.js` carries `__PLACEHOLDER__` address tokens that are
> substituted from these `NEXT_PUBLIC_*` vars at `next build` (`web/scripts/replace-embed-addrs.js`) —
> never hardcode an address into the embed.

> **Secrets stay server-side.** The Claude-API "Ask Access0x1" key, deploy keys, and any RPC URL that
> embeds an API key are **server-side only / `.env` only**, never in client code, the embed, or the
> repo. The public repo means a leaked key is a drained key.

---

## Supported chains

Same-chain settlement is shipped on the three event chains, with the full first-party stack live on
several more testnets. **Cite [docs/CHAIN-ADDRESSES.md](CHAIN-ADDRESSES.md) for the verified USDC +
Chainlink feed address on every chain** (each re-verified on-chain on 2026-06-17; nothing guessed).
**There are no mainnet deployments and no mainnet claims** — Access0x1 is testnet-only.

| Chain | id | USDC pay-in | Notes |
| --- | --- | --- | --- |
| **Arc Testnet** | `5042002` | `0x3600…0000` (native) | USDC **is** the native gas token → "no gas fee" copy is truthful here, and only here. Source-verified. |
| **Base Sepolia** | `84532` | `0x036CbD…dCF7e` | The primary EVM example chain. Source-verified. Carries the live example merchant. |
| **zkSync Sepolia** | `300` | see [CHAIN-ADDRESSES.md](CHAIN-ADDRESSES.md) | One-command deploy-ready via the EraVM path; not yet broadcast at time of writing. |

Beyond these three, the **CREATE3 mirror** (one address — see below) is live on a total of **eight
testnets**: Arc, Base Sepolia, **Ethereum Sepolia (11155111)**, **Optimism Sepolia (11155420)**,
**Avalanche Fuji (43113)**, **Robinhood Chain (46630)**, **Arbitrum Sepolia (421614)**, and **Celo
Sepolia (11142220)** — source-verified on seven of them. Three earlier chains (**Ethereum Hoodi
(560048)**, **0G Galileo (16602)**, **Tempo (42431)**) carry **pre-mirror** per-chain deploys, with
~30 more testnets one-command deploy-ready. The per-chain USDC token and Chainlink feed addresses for
all of them live in [docs/CHAIN-ADDRESSES.md](CHAIN-ADDRESSES.md) — the single source of truth for
those addresses; the live mirror/per-chain status is the
[README Deployments table](../README.md#deployments).

> **One router, every chain.** The integration is identical across chains — only the `routerAddress`
> (and the USDC `token` address) changes. The contract code is the same multi-tenant router everywhere.

---

## The router address you point at

`Access0x1Router` is the only address an integrator points at — and via the **CREATE3 mirror** it is the
**same address on every chain the mirror is live on**:

```text
0xe92244e3368561faf21648146511DeDE3a475EB5
```

This same address is live on **eight testnets** today (Arc `5042002`, Base Sepolia `84532`, Ethereum
Sepolia `11155111`, Optimism Sepolia `11155420`, Avalanche Fuji `43113`, Robinhood `46630`, Arbitrum
Sepolia `421614`, Celo Sepolia `11142220`) and source-verified on seven of them; it resolves on every
further chain as it is cut over (see [`MIRROR-CUTOVER.md`](MIRROR-CUTOVER.md)). The only other per-chain
value is the USDC `token` address — the contract code is the same multi-tenant router everywhere. The
canonical, broadcast-derived set is published once in
[`script/mirror-manifest.json`](../script/mirror-manifest.json) and shown in the
[README Deployments table](../README.md#deployments) — never hand-copied.

Chains not yet on the mirror still run their own **pre-mirror** per-chain router. Don't hand-copy it: read
it from the canonical, broadcast-derived source ([`web/lib/deployments.ts`](../web/lib/deployments.ts) or
the [README Deployments table](../README.md#deployments)) and confirm the live feed/merchant config
on-chain before relying on it. **Never invent or hand-copy an address** (law #4).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Button does nothing / `embed.js` renders the USD-only label | The router address for that chain is still a `__PLACEHOLDER__` (embed wasn't built with `NEXT_PUBLIC_*` set) | Set `NEXT_PUBLIC_ROUTER_*` for the chain and rebuild; check the browser console for `[access0x1] embed.js` warnings. |
| `embed.js` logs `missing/invalid data-merchant / data-slug` | Neither a numeric `data-merchant` nor a valid `data-slug` was provided | Add a numeric `data-merchant` **or** a slug matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`. |
| `embed.js` logs `invalid data-amount-usd` | Amount is zero, blank, or malformed | Use a positive decimal string, e.g. `data-amount-usd="29.00"`. |
| SDK error `MERCHANT_NOT_FOUND` / `useMerchant` returns all-zero | `merchantId` isn't registered on that router/chain | Register at `/onboard` (or via `registerMerchant`) on the **same chain** as your `routerAddress`; check `isUnregistered()`. |
| SDK error `MERCHANT_INACTIVE` | The merchant exists but is paused/inactive | Re-activate the merchant from the dashboard (the merchant owner controls this). |
| SDK error `UNDERPAID` | Sent value/allowance is below the live quote | Let the SDK quote first; for native pay it sets `msg.value` from the quote, for ERC-20 it approves the exact gross — don't override the amount. |
| SDK error `STALE_PRICE` | The Chainlink feed for that token is past the staleness window | Pick a token whose feed is live on that chain (see [CHAIN-ADDRESSES.md](CHAIN-ADDRESSES.md)); on a feed-less chain, pricing is off until a feed is wired. |
| SDK error `FEE_ON_TRANSFER_TOKEN` | The chosen ERC-20 deducts a transfer fee | The router rejects fee-on-transfer tokens by design — pay in a standard token (USDC). |
| SDK error `USER_REJECTED` | Buyer dismissed the wallet prompt | Expected — surface a "try again" affordance; the hook's `reset()` clears state. |
| ERC-20 pay never prompts / fails before quote | No `token` address, or the token isn't allowlisted on the router | Pass the chain's USDC `token` (from CHAIN-ADDRESSES.md); only allowlisted real ERC-20s are accepted (no mock token). |
| Type error: `merchantId` rejected | Passed a JS `number` | `merchantId` is a `bigint` — write `42n`. |
| `clientFromViem(publicClient!, …)` is undefined | wagmi's `usePublicClient()` returned `undefined` (no chain configured / wallet not ready) | Ensure your wagmi config has the chain, and guard the render until `publicClient` is ready. |
| Wrong network / quote reverts | Wallet is on a different chain than `routerAddress` | Prompt the buyer to switch to the settlement chain before paying. |
| "No gas fee" label looks wrong off Arc | "Free gas" is only truthful on Arc (USDC = native gas) | Don't pass a "no gas" `label` on non-Arc chains; the buyer pays that chain's gas token. |

Still stuck? The contract surface, money-path semantics, and per-chain operator notes are documented in
the [README](../README.md), [docs/CHAIN-ADDRESSES.md](CHAIN-ADDRESSES.md), and
[docs/DEPLOY-TESTNETS.md](DEPLOY-TESTNETS.md). Open an issue at
<https://github.com/Access0x1/Access0x1/issues>.
