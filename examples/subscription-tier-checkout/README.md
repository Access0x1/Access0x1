# Subscription tier checkout — sign once, auto-renew

A subscriber joins a **"Pro" plan ($29.00 / period)** and signs **exactly one**
wallet prompt. That prompt opens a budget-scoped [`SessionGrant`](../../src/SessionGrant.sol):
it authorizes the [`Access0x1Subscriptions`](../../src/Access0x1Subscriptions.sol)
contract to spend up to a cap until an expiry. Every later `renew` debits that
budget and pulls the period charge through the router fee-split — **with no further
prompt**. `SessionGrant` never holds funds; it is a pure authorization ledger, and
the budget is a **never-negative meter** — a charge past the cap hard-reverts.

Run it: [`subscribe.mjs`](./subscribe.mjs) (Node + [viem](https://viem.sh)).

## Value flow

### Before — subscriber has approved nothing; no session exists

```
subscriber wallet      SessionGrant        Access0x1Subscriptions      merchant payout
 [ USDC ]               (no session)        (no subscription)           balance n
```

### After — one signature opens a session; renewals need no prompt

```
SIGN ONCE
subscriber ──openSession(Subscriptions, budgetCap=$120, expiry)──▶ SessionGrant
                                                                    └─ sessionId (budget meter)

subscriber ──subscribe(merchantId, planKey, USDC, sessionId, withTrial=false)──▶ Subscriptions
   period 1 charge ──▶ Access0x1Router (USD→token, fee-split) ──┬─▶ merchant payout (+ net)
                                                                └─▶ treasury        (+ fee)

NO PROMPT (any caller / keeper)
renew(subId) ──▶ Subscriptions.spend(sessionId, priceUsd8) ──▶ Router fee-split ──▶ merchant + treasury
   budget:  $120  →  $91  →  $62 …   (debited each period; hard-reverts below 0)
```

`$29.00` is `2_900_000_000` and the `$120.00` budget is `12_000_000_000` in the
router's **USD-8** fixed point (8 decimals).

## Prerequisites

1. A **registered merchant** with a **defined plan**. The merchant owner calls
   `setPlan(merchantId, planKey, priceUsd8, periodSecs, active)` once (see
   [RECIPES](../../docs/RECIPES.md)). This script is the **subscriber** side, so
   the plan must already exist for the `MERCHANT_ID` / `PLAN_KEY` you target.
2. A **funded testnet dev wallet** with Base Sepolia ETH (gas) and testnet USDC
   (the charges). Throwaway key only — **never** a key with real value.

## Run

```sh
npm i viem
export RPC_URL=https://sepolia.base.org
export PRIVATE_KEY=0x<funded-dev-key>
export MERCHANT_ID=<your registered id>      # defaults to 1
node subscribe.mjs
```

Expected output:

```
Session opened: 0x… (cap $120.00, delegate = Subscriptions)
Subscribed. subId = … — $29.00/period charged.
Future renewals: renew(subId) — debits the budget, no further wallet prompt.
```

## Auto-renew without a cron

`renew(subId)` is permissionless and reverts when the period isn't due yet — so it
is safe to poll. The protocol ships a keeper for it: the
[`AutomationGateway`](../../src/AutomationGateway.sol) is a Chainlink Automation
front-door (`checkUpkeep` / `performUpkeep`) that auto-renews due subscriptions with
**zero custody and zero privilege** — it only pokes the self-guarding `renew`.

## Addresses

`Access0x1Subscriptions` = `0x787D2d97F7b0B0A7aFE1eCD97032912fefE8e0ba`,
`SessionGrant` = `0xf84fEA541939f3683893530101Fe77d05c390C9d`,
`Access0x1Router` = `0xe92244e3368561faf21648146511DeDE3a475EB5`, USDC =
`0x036CbD53842c5426634e7929541eC2318f3dCF7e` on **Base Sepolia** (`84532`), all from
the **CREATE3 mirror** (identical on every mirrored chain). Source of truth: the
README [Deployments](../../README.md#deployments) table — re-confirm on the explorer
before real value (LAW #4).
