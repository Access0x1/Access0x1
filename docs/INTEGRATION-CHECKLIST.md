# Integration checklist — onboard a store, end to end

A linear, copy-as-you-go checklist that takes a merchant from "nothing" to a live,
USD-priced crypto checkout on a testnet. It deliberately **does not restate
addresses or code** — each step points at the doc that owns it, so this page never
drifts. If you only read one prose guide first, make it
[GETTING-STARTED.md](./GETTING-STARTED.md); for the SDK paths, [QUICKSTART.md](./QUICKSTART.md).

> **Scope: testnet only.** Access0x1 is an ETHGlobal NY 2026 testnet build with no
> mainnet deployments (see the [README](../README.md) banner and
> [FAQ → Can I run this on mainnet?](./FAQ.md#can-i-run-this-on-mainnet)). "Go live"
> below means *live on a testnet*.

---

## 0. Pre-flight

- [ ] A wallet you control (browser extension or an embedded wallet via the app).
- [ ] A **payout address** decided — where your net payments land. It can be the
      same wallet or a separate treasury; it must be non-zero.
- [ ] Test funds on your target chain (faucet) to cover registration gas. On Arc,
      gas is paid in USDC; on other chains, in that chain's native token.
- [ ] You've picked a target chain and read its row in
      [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) — the **router address**, chain id,
      USDC token, and price feed all come from there (never from a tutorial).

## 1. Register the merchant

Get a `merchantId` — you do this **once per chain**, and you become the merchant
owner (the only address that can update your config).

- [ ] **Easiest:** use the hosted onboarding wizard at `/onboard` on the Access0x1
      app — connect your wallet, set your payout address + optional surcharge, and
      it makes the call and shows your `merchantId`. (See
      [QUICKSTART.md → Step 0](./QUICKSTART.md).)
- [ ] **Or directly:** call
      `registerMerchant(payout, feeRecipient, feeBps, nameHash)` with `cast` or
      viem. It returns your `merchantId` (≥ 1). See the
      [Router surface](../README.md#the-contract-surface) and
      [registerMerchant NatSpec](../src/Access0x1Router.sol).
- [ ] **Record your `merchantId`** — every drop-in needs it.

> `feeRecipient = address(0)` is allowed — it falls back to your payout address at
> pay time. `nameHash` is an identity commitment (no preimage is stored on-chain).

## 2. Configure your payout & fee

- [ ] **Payout** is set at registration; change it any time with
      `updateMerchant(id, payout, feeRecipient, feeBps, active)` — **owner only**.
- [ ] **Your surcharge** (`feeBps`) is optional and in basis points (100 bps = 1%).
      `feeBps + platformFeeBps` must not exceed `MAX_FEE_BPS` (10%) or the call
      reverts — see [FAQ → fees](./FAQ.md#what-stops-the-platform-from-taking-a-huge-fee).
- [ ] The **platform fee** is set by the protocol owner, not you; your buyer is
      never charged more than the cap regardless.
- [ ] (Optional) To transfer merchant ownership later, use the two-step
      `proposeMerchantOwner` / `acceptMerchantOwner` handshake — a config update can
      never hand control to another address.

## 3. Drop checkout into your app

Pick the integration that fits — all three settle through the same router with the
same guarantees. Point each at your `merchantId` and the **router address from
[CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md)**.

- [ ] **React SDK** — `<PayButton>` / `usePayment` from
      [`@access0x1/react`](../packages/react). Most control.
      ([GETTING-STARTED → Path 1](./GETTING-STARTED.md#path-1--accept-your-first-payment-react-sdk))
- [ ] **One-tag embed** — drop `embed.js` with `data-merchant` + `data-amount-usd`
      onto any HTML page. No build step. ([QUICKSTART.md](./QUICKSTART.md))
- [ ] **Hosted checkout** — link straight to `/m/{merchantId}?amount=…&chainId=…`
      on the app. No code at all.
- [ ] **Starting fresh?** Scaffold the pre-wired starter:
      `npx degit Access0x1/Access0x1/templates/starter my-checkout`
      ([GETTING-STARTED → Path 3](./GETTING-STARTED.md#path-3--scaffold-a-pre-wired-starter)).

## 4. Test a real payment

- [ ] Run a single small payment end to end against your target chain.
- [ ] Confirm on the explorer that the **net landed in your payout address** and
      the **fee landed at the treasury / your fee recipient** — `net + fee` equals
      what the buyer paid.
- [ ] Verify the **USD price** matched: the router priced via the Chainlink feed
      *in the settlement tx*, not the frontend preview.
- [ ] (Optional) Drive the whole flow locally first with no keys:
      `make deploy-local` → `make drive-local`
      ([GETTING-STARTED → Path 2](./GETTING-STARTED.md#path-2--run-the-whole-thing-locally-no-keys)),
      or pay by hand with `cast` ([MANUAL-TESTING.md](./MANUAL-TESTING.md)).
- [ ] If you sell subscriptions / bookings / invoices / gift cards, exercise that
      contract too — see [RECIPES.md](./RECIPES.md).

## 5. Go live (on testnet)

- [ ] Replace any test/placeholder router address with the verified one from
      [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) and confirm it on the explorer.
- [ ] Set `active = true` on your merchant record (it defaults to active at
      registration; re-check after any `updateMerchant`).
- [ ] Make sure your app reads addresses/feeds **from env, never hardcoded**
      (law #4) — see [`.env.example`](../.env.example).
- [ ] Ship the checkout to your live URL.

## 6. Operate

- [ ] **Refunds always work** — the refund legs are oracle-free, so a stale feed
      can never block a refund ([FAQ → Chainlink down](./FAQ.md#what-if-the-chainlink-price-feed-goes-down-or-returns-a-stale-price)).
- [ ] **Pause** is a platform-owner control, not a merchant one; to stop taking
      payments yourself, set your merchant `active = false`.
- [ ] **Standing up your own router on a new testnet?** Follow
      [DEPLOY-TESTNETS.md](./DEPLOY-TESTNETS.md); to roll the CREATE3 mirror across
      chains, [MIRROR-CUTOVER.md](./MIRROR-CUTOVER.md).
- [ ] **Security issue?** Private disclosure only — [SECURITY.md](../SECURITY.md).

---

## Quick reference

| You need… | Go to |
| --- | --- |
| A live router address / chain id / feed | [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) |
| The 60-second model + three copy-paste paths | [GETTING-STARTED.md](./GETTING-STARTED.md) |
| SDK / embed / hosted checkout details | [QUICKSTART.md](./QUICKSTART.md) |
| Subscriptions, bookings, invoices, gift cards | [RECIPES.md](./RECIPES.md) |
| Common questions & objections | [FAQ.md](./FAQ.md) |
| Deploy your own stack to a testnet | [DEPLOY-TESTNETS.md](./DEPLOY-TESTNETS.md) |
| A term you don't recognize | [GLOSSARY.md](./GLOSSARY.md) |

Stuck on a step? Open an issue at
[github.com/Access0x1/Access0x1](https://github.com/Access0x1/Access0x1) — except
vulnerabilities, which follow [SECURITY.md](../SECURITY.md).
