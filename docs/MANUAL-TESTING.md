# Manual Testing Runbook

Hand-test every contract and the web app, end to end, on your own machine. This
is written for a careful operator who is **not** a Solidity expert: copy each
block, run it, and check the result against the **Expected** line under it.

Everything here runs **locally** against a throwaway [Anvil](https://book.getfoundry.sh/anvil/)
chain. No real money, no real keys, no testnet, nothing to lose. The same flows
the automated suite proves (920 contract tests + the web gate) you will drive by
hand, so you can see the money move and the guards bite.

> **Naming note.** This document only uses public, standard names: Anvil, Arc,
> Circle, USDC, Chainlink, and the contract names (`Access0x1Router`, etc.).
> Nothing here is private.

**Contents**

- [A. Local setup (one time)](#a-local-setup-one-time)
- [B. Per-contract `cast` walkthroughs](#b-per-contract-cast-walkthroughs)
  - [B0. The shared variables you set once](#b0-the-shared-variables-you-set-once)
  - [B1. Router — register → quote → pay → conservation + zero custody](#b1-router--register--quote--pay--conservation--zero-custody)
  - [B2. Subscriptions — setPlan → subscribe → renew (in-budget + over-budget)](#b2-subscriptions--setplan--subscribe--renew-in-budget--over-budget)
  - [B3. Bookings — reserve → confirm → complete (+ late-cancel refund)](#b3-bookings--reserve--confirm--complete--late-cancel-refund)
  - [B4. Invoices — createInvoice → pay once (second pay reverts)](#b4-invoices--createinvoice--pay-once-second-pay-reverts)
  - [B5. GiftCards — issue → redeem → never-negative](#b5-giftcards--issue--redeem--never-negative)
  - [B6. PaymentLanes — credit → claim](#b6-paymentlanes--credit--claim)
  - [B7. SessionGrant — openSession → spend → revoke](#b7-sessiongrant--opensession--spend--revoke)
  - [B8. Nft — list → buy](#b8-nft--list--buy)
- [C. Web app — onboarding, checkout, verify, dashboard](#c-web-app--onboarding-checkout-verify-dashboard)
- [D. The test suites (920 + web gate)](#d-the-test-suites-920--web-gate)
- [E. Pre-demo smoke checklist](#e-pre-demo-smoke-checklist)

---

## A. Local setup (one time)

You need three tools: **Foundry** (the `forge`/`cast`/`anvil` toolchain), **Node**
(for the web app), and this repo's dependencies. Run these once.

### A1. Install Foundry

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

**Expected:** `foundryup` prints `forge`, `cast`, `anvil`, `chisel` versions at
the end. Confirm they are on your PATH:

```bash
forge --version && cast --version && anvil --version
```

**Expected:** three version lines, no "command not found".

> The Makefile prepends `~/.foundry/bin` to PATH inside every recipe, so `make`
> targets work even if your shell PATH does not have Foundry. When you run a raw
> `cast` command yourself (Section B), make sure Foundry is on your PATH first:
> `export PATH="$HOME/.foundry/bin:$PATH"`.

### A2. Install the dependencies

From the repo root:

```bash
make install
```

This runs `git submodule update --init --recursive` (Forge libraries),
`npm install` (the `@chainlink/contracts` the contracts import), `cd web && npm
install` (the web app), and the React SDK install.

**Expected:** ends without an error. If you later see a build error like
`@chainlink/contracts/.../AggregatorV3Interface.sol not found`, re-run
`npm install` at the repo root — the contract build reads Chainlink interfaces
out of `node_modules`.

### A3. Build the contracts (sanity)

```bash
make build
```

**Expected:** `forge build` finishes and the last line is a successful compile
(or `No files changed, compilation skipped` if nothing changed). No `Error`
lines. This is the green light that the toolchain is wired correctly.

### A4. Start a local chain (Anvil) — leave this running

Open a **dedicated terminal** and start the node. Keep it open for the whole
session:

```bash
make anvil
```

**Expected:** Anvil prints **10 funded accounts** with their addresses and
**private keys**, a mnemonic, and `Listening on 127.0.0.1:8545`. The first
account,

```
(0) 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (10000 ETH)
```

is the one every command in this runbook uses as the deployer/caller. Anvil's
keys are **well-known public test keys** — never send real funds to them.

### A5. Deploy the whole estate to Anvil — the keyless path

In a **second terminal** (Anvil keeps running in the first):

```bash
make deploy-local
```

What this does (`script/DeployAll.s.sol`, the one-command multi-chain deploy):

- `HelperConfig` detects chain id `31337` and **deploys fresh mocks** for you: a
  mock USDC (6-decimal, like Base/Arc), a mock USDC/USD Chainlink feed pinned at
  `$1.00`, a mock native/USD feed at `$2000`, and a `ChainRegistry`.
- Then it deploys, in one broadcast, the **money spine** (`Access0x1Router` +
  `SessionGrant`), the house-token factory, and the **commerce quintet**
  (`Access0x1Subscriptions`, `Access0x1Bookings`, `Access0x1Invoices`,
  `Access0x1GiftCards`, `Access0x1Nft`), and allowlists + prices the mock USDC on the Router.

It runs **`--unlocked --sender 0xf39…2266`** — Anvil's first account, unlocked,
**no keystore and no private key**. That is the verified keyless local path; the
`ANVIL_SENDER` variable at the top of the Makefile sets that sender.

**Expected:** lots of `-vvvv` trace, then a block of address logs near the end:

```
Access0x1Router       : 0x...
SessionGrant          : 0x...
HouseTokenFactory     : 0x...
Access0x1Subscriptions: 0x...
Access0x1Bookings     : 0x...
Access0x1Invoices     : 0x...
Access0x1GiftCards    : 0x...
  USDC allowlisted    : 0x...     <- this is the mock USDC address
  USDC/USD feed       : 0x...
```

and `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`.

> `PaymentLanes` and `Access0x1Receiver` are **off by default** locally
> (`DEPLOY_PAYMENT_LANES` unset, no CRE forwarder). To also deploy + wire
> PaymentLanes, run: `DEPLOY_PAYMENT_LANES=true make deploy-local`. `Access0x1Nft`
> is **not** part of `DeployAll`; Section B8 deploys it standalone.

### A6. Read the deployed addresses

Two ways. Easiest: **scroll up** to the address block you just saw. Or read them
out of the broadcast file Foundry wrote:

```bash
cat broadcast/DeployAll.s.sol/31337/run-latest.json \
  | jq -r '.transactions[] | select(.transactionType=="CREATE") | "\(.contractName)\t\(.contractAddress)"'
```

**Expected:** one line per deployed contract, e.g.
`Access0x1Router  0x5FbDB…`. Note the addresses for `Access0x1Router`,
`SessionGrant`, `Access0x1Subscriptions`, `Access0x1Bookings`,
`Access0x1Invoices`, `Access0x1GiftCards`, and the **mock `MockUSDC`**. You will
paste these into the commands below.

> **The fastest sanity check of all.** Before the manual `cast` work, run the
> one-shot money-flow driver. It deploys a throwaway Router + mock USDC + feed,
> onboards a coffee shop, and settles one real `$5` USDC payment, printing the
> split:
>
> ```bash
> make drive-local
> ```
>
> **Expected** (the last lines):
> ```
> gross  (USDC)   : 5000000
> platformFee     : 50000
> net    (USDC)   : 4950000
> net+fee==gross  : true
> router USDC bal : 0          <- zero custody
> ```
> If you see `true` and a `0` router balance, the whole money path works on your
> machine. Now do the per-contract walkthroughs to exercise each one by hand.

---

## B. Per-contract `cast` walkthroughs

These drive the contracts the SDK/frontend would call, but by hand with `cast`,
so you can read each result yourself. Each block shows the exact command with
**placeholders in `<ANGLE_BRACKETS>`** — replace them with your deployed
addresses from A6 — and the **Expected** result.

### B0. The shared variables you set once

Run this in your **second terminal** (the one you deployed from). Paste the
addresses you read in A6 where shown. `PRICE_ZERO` aside, you do not need to
understand each value yet — the walkthroughs explain them as they use them.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
export RPC=http://localhost:8545

# Anvil account[0] — the unlocked deployer/caller for everything below.
export ME=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# Its well-known PUBLIC test key (Anvil prints it on startup). Local only.
export PK=0xac0974bec39a17e36ba4a6b4d238ff944bababc08a3bb9c2b9bb1c5c2e5b89b3

# A second Anvil account to play "the customer" against "the merchant".
export ALICE=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
export ALICE_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

# ↓↓↓ paste YOUR addresses from step A6 ↓↓↓
export ROUTER=<ROUTER_ADDRESS>
export USDC=<MOCK_USDC_ADDRESS>
export SUBS=<SUBSCRIPTIONS_ADDRESS>
export BOOKINGS=<BOOKINGS_ADDRESS>
export INVOICES=<INVOICES_ADDRESS>
export GIFTCARDS=<GIFTCARDS_ADDRESS>
export GRANT=<SESSIONGRANT_ADDRESS>
```

> **How to read these commands.** `cast call` is a **read** (no transaction, no
> gas, returns a value). `cast send` is a **write** (a real transaction on your
> Anvil chain). Amounts in this system use two units: token amounts are in the
> token's own decimals (mock USDC is **6 decimals**, so `5000000` = `$5`), and
> **USD prices are 8-decimal** (`5e8` = `500000000` = `$5.00`). The Router reads
> the live feed and converts USD → token in-transaction.

### B1. Router — register → quote → pay → conservation + zero custody

This is the money spine. We onboard a merchant, get a live quote, pay it, and
prove **net + fee == gross** with **zero custody** (the Router holds nothing
after).

**1. Register a merchant.** `payout` is where the merchant's net lands;
`feeRecipient = 0` falls back to payout; `feeBps = 0` (no merchant surcharge);
the last arg is an identity commitment hash.

```bash
cast send $ROUTER \
  "registerMerchant(address,address,uint16,bytes32)" \
  $ME 0x0000000000000000000000000000000000000000 0 \
  $(cast keccak "bean-scene") \
  --rpc-url $RPC --private-key $PK
```

**Expected:** a transaction receipt with `status 1 (success)`. The first
merchant id is **1**. Confirm it:

```bash
cast call $ROUTER "nextMerchantId()(uint256)" --rpc-url $RPC
```

**Expected:** `2` (the next id to be assigned — so the one you just created is
`1`). Set it:

```bash
export MID=1
```

Read the merchant record back:

```bash
cast call $ROUTER "merchants(uint256)(address,address,address,uint16,bool,bytes32)" $MID --rpc-url $RPC
```

**Expected:** `payout = $ME`, `owner = $ME`, `feeBps = 0`, `active = true`.
Onboarding is permissionless: whoever calls becomes the owner.

**2. Quote a $5 latte.** The middle arg of `quote` is ignored (kept for ABI
compatibility); pass `0`. `500000000` is `$5.00` in 8-dp USD.

```bash
cast call $ROUTER "quote(uint256,address,uint256)(uint256)" 0 $USDC 500000000 --rpc-url $RPC
```

**Expected:** `5000000` — that is `5 USDC` (6 decimals) at the `$1.00` feed
price. The price is read **in-transaction from the Chainlink feed**, not passed
in by the caller.

**3. Fund + approve the customer, then pay.** Give Anvil account[0] some mock
USDC, approve the Router to pull it, then `payToken`. The last arg is an order
id (any 32-byte value).

```bash
# Mint the caller 1,000 USDC on the mock token (MockUSDC has an open mint).
cast send $USDC "mint(address,uint256)" $ME 1000000000 --rpc-url $RPC --private-key $PK
# One-time checkout approval.
cast send $USDC "approve(address,uint256)" $ROUTER \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --rpc-url $RPC --private-key $PK
# Pay the $5 latte.
cast send $ROUTER "payToken(uint256,address,uint256,bytes32)" \
  $MID $USDC 500000000 $(cast keccak "order-0001") \
  --rpc-url $RPC --private-key $PK
```

**Expected:** all three return `status 1 (success)`.

**4. Prove the split + zero custody.** The platform fee is 1% (100 bps). On a $5
payment: fee `= 50000` (0.05 USDC), net `= 4950000` (4.95 USDC). Here the caller
is also the payout and treasury, so check the Router holds nothing:

```bash
cast call $USDC "balanceOf(address)(uint256)" $ROUTER --rpc-url $RPC
```

**Expected:** `0`. The Router never parks the business's money — **zero
custody**, the single most important invariant. `net + fee == gross` is proven by
construction: the Router pulled exactly `5000000`, paid `4950000` to the payout,
`50000` to the treasury, and kept `0`.

### B2. Subscriptions — setPlan → subscribe → renew (in-budget + over-budget)

A SaaS sells a `$29/mo` plan. The customer authorizes **one** SessionGrant
budget; a keeper renews each month, but can never charge a cent past the budget
(the never-negative meter). We will budget **exactly two charges** and watch the
third hit the wall.

> This one needs **EIP-712 signing** for the SessionGrant only if you go through
> the relayed path. The simplest hand-test opens the session **directly** from
> the subscriber's own key (no signature needed), which is what we do here.

**1. Define the plan.** As the merchant owner from B1 (`$MID = 1`), set plan key
`1` to `$29.00` (`2900000000` in 8-dp) on a 30-day period (`2592000` seconds),
active:

```bash
cast send $SUBS "setPlan(uint256,uint8,uint256,uint32,bool)" \
  $MID 1 2900000000 2592000 true \
  --rpc-url $RPC --private-key $PK
```

**Expected:** `status 1`.

**2. The customer (Alice) funds + approves the Subscriptions contract.**

```bash
cast send $USDC "mint(address,uint256)" $ALICE 1000000000 --rpc-url $RPC --private-key $PK
cast send $USDC "approve(address,uint256)" $SUBS \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --rpc-url $RPC --private-key $ALICE_PK
```

**3. Alice opens a SessionGrant budgeting exactly 2 charges** ($58 = `5800000000`
in 8-dp), delegate = the Subscriptions contract, expiry far in the future. The
`sessionId` is returned; read it from the call first, then send:

```bash
# Far-future expiry (year ~2030).
export EXPIRY=1900000000
# Preview the sessionId this will create (a read against the same inputs):
cast call $GRANT "openSession(address,uint256,uint64)(bytes32)" \
  $SUBS 5800000000 $EXPIRY --rpc-url $RPC --from $ALICE
```

**Expected:** a `0x…` 32-byte session id. **Copy it** into `SID`, then actually
open the session:

```bash
export SID=<SESSION_ID_FROM_ABOVE>
cast send $GRANT "openSession(address,uint256,uint64)" \
  $SUBS 5800000000 $EXPIRY --rpc-url $RPC --private-key $ALICE_PK
cast call $GRANT "remaining(bytes32)(uint256)" $SID --rpc-url $RPC
```

**Expected:** `remaining` = `5800000000` — the full $58 budget is available.

**4. Subscribe (charges period 1 immediately).** Args: merchant, plan key, token,
sessionId, `withTrial=false`.

```bash
cast send $SUBS "subscribe(uint256,uint8,address,bytes32,bool)" \
  $MID 1 $USDC $SID false --rpc-url $RPC --private-key $ALICE_PK
```

**Expected:** `status 1`. The first `$29` was pulled through the Router
fee-split. Confirm the budget dropped by one charge:

```bash
cast call $GRANT "remaining(bytes32)(uint256)" $SID --rpc-url $RPC
```

**Expected:** `2900000000` — one charge ($29) left. The returned subscription id
is **1**; set `export SUBID=1`.

**5. Renew once, in budget.** A keeper (any address) renews. `cast call` first to
read what it would charge, then send:

```bash
cast send $SUBS "renew(uint256)" $SUBID --rpc-url $RPC --private-key $PK
cast call $GRANT "remaining(bytes32)(uint256)" $SID --rpc-url $RPC
```

**Expected:** `status 1`, and `remaining` = `0` — the budget is now exactly
exhausted (two charges spent of a two-charge budget). Note: a real renewal in
production also needs the feed to be fresh; on Anvil the mock feed stays fresh.

**6. Renew again — over budget — and watch it NOT overcharge.** The third charge
has no budget. `renew` catches the meter revert and **duns** the subscription
instead of charging:

```bash
# Snapshot Alice's balance first.
cast call $USDC "balanceOf(address)(uint256)" $ALICE --rpc-url $RPC
cast send $SUBS "renew(uint256)" $SUBID --rpc-url $RPC --private-key $PK
# Re-read Alice's balance + the budget.
cast call $USDC "balanceOf(address)(uint256)" $ALICE --rpc-url $RPC
cast call $GRANT "remaining(bytes32)(uint256)" $SID --rpc-url $RPC
```

**Expected:** the `renew` transaction **succeeds** (`status 1`) but **charges
nothing**: Alice's balance is **unchanged** between the two reads, and
`remaining` is still `0` — never negative, never overspent. The subscription is
now marked `PAST_DUE` (dunned), not silently overcharged. This is the
never-negative guarantee, by hand.

### B3. Bookings — reserve → confirm → complete (+ late-cancel refund)

A salon takes a refundable `$40` deposit. We reserve, confirm, and complete the
happy path; then a second booking shows the **late-cancel** refund (fee kept,
remainder refunded, refund never negative).

**1. Alice funds + approves the Bookings contract.**

```bash
cast send $USDC "mint(address,uint256)" $ALICE 1000000000 --rpc-url $RPC --private-key $PK
cast send $USDC "approve(address,uint256)" $BOOKINGS \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --rpc-url $RPC --private-key $ALICE_PK
```

**2. Reserve a slot.** The `Policy` is a struct passed as a tuple
`(cancelWindowSecs, lateFeeUsd8, noShowFeeUsd8)`. Here: 24h window
(`86400`), `$15` late fee (`1500000000`), `$25` no-show fee (`2500000000`).
Deposit `$40` = `4000000000` (8-dp). `slotTimestamp` is the appointment time —
pick a value a week out; `holdSecs` = two weeks (`1209600`); the last two args are
the balance-due (0) and a unique nonce.

```bash
# A slot key and an appointment timestamp ~7 days out.
export SLOT=$(cast keccak "chair-1-friday-2pm")
export APPT=$(($(date +%s) + 604800))
cast send $BOOKINGS \
  "reserve(uint256,bytes32,uint64,address,uint256,uint256,(uint32,uint256,uint256),uint64,bytes32)" \
  $MID $SLOT $APPT $USDC 4000000000 0 \
  "(86400,1500000000,2500000000)" 1209600 $(cast keccak "nonce-b1") \
  --rpc-url $RPC --private-key $ALICE_PK
```

**Expected:** `status 1`. Reservation id is **1**; `export RID=1`. Confirm the
deposit escrowed:

```bash
cast call $BOOKINGS "escrowedOf(address)(uint256)" $USDC --rpc-url $RPC
cast call $USDC "balanceOf(address)(uint256)" $BOOKINGS --rpc-url $RPC
```

**Expected:** both = `40000000` (40 USDC). The escrow ledger exactly tracks the
contract's real balance (conservation).

**3. The merchant confirms, then completes.** Confirm is pure intent (no money
moves); complete settles the deposit to the salon through the fee-split:

```bash
cast send $BOOKINGS "confirm(uint256)" $RID --rpc-url $RPC --private-key $PK
cast send $BOOKINGS "complete(uint256)" $RID --rpc-url $RPC --private-key $PK
```

**Expected:** both `status 1`. After complete, the escrow ledger drains:

```bash
cast call $BOOKINGS "escrowedOf(address)(uint256)" $USDC --rpc-url $RPC
cast call $USDC "balanceOf(address)(uint256)" $BOOKINGS --rpc-url $RPC
```

**Expected:** both `0` — no money stranded in the contract. The slot is freed:

```bash
cast call $BOOKINGS "isSlotFree(bytes32)(bool)" $SLOT --rpc-url $RPC
```

**Expected:** `true`.

**4. Late-cancel a fresh booking (fee kept, remainder refunded).** Reserve again
with a new slot + nonce, confirm, then have Alice cancel. `cancel(id, actorType)`
takes an actor enum: `0 = PAYER` (the customer), `1 = MERCHANT`.

```bash
export SLOT2=$(cast keccak "chair-2-sat-10am")
cast send $BOOKINGS \
  "reserve(uint256,bytes32,uint64,address,uint256,uint256,(uint32,uint256,uint256),uint64,bytes32)" \
  $MID $SLOT2 $APPT $USDC 4000000000 0 \
  "(86400,1500000000,2500000000)" 1209600 $(cast keccak "nonce-b2") \
  --rpc-url $RPC --private-key $ALICE_PK
export RID2=2
cast send $BOOKINGS "confirm(uint256)" $RID2 --rpc-url $RPC --private-key $PK

# Snapshot Alice before the cancel.
cast call $USDC "balanceOf(address)(uint256)" $ALICE --rpc-url $RPC
# Alice cancels as the PAYER (actor 0).
cast send $BOOKINGS "cancel(uint256,uint8)" $RID2 0 --rpc-url $RPC --private-key $ALICE_PK
cast call $USDC "balanceOf(address)(uint256)" $ALICE --rpc-url $RPC
```

**Expected:** `status 1`. Alice's balance goes **up by the refund** =
`escrow − lateFee`. The late fee is **re-quoted at cancel time** (so price drift
cannot be gamed) and **clamped to the escrow** so the refund is never negative.
The escrow ledger drains to `0` again.

> **Refund-never-blocked, by design.** The automated suite proves the harder
> case: even if the price feed goes **stale** when a no-show is marked, the
> contract treats it as "take no fee" and refunds the **full** deposit rather
> than bricking on a dead oracle (law #5). You don't need to force a stale feed
> by hand — that's `test_scenario_salon_noShow_staleFeed_refundsFullEscrow_neverBlocked`
> in `test/scenario/SalonBooking.scenario.t.sol`.

### B4. Invoices — createInvoice → pay once (second pay reverts)

A freelancer sends a `$1,200` invoice locked to one client. The client pays once;
a **second** pay reverts (no double-charge).

**1. Create the invoice** (as the merchant owner). Args: merchant, payer (Alice),
token, amount `$1,200` = `120000000000` (8-dp), `dueBy` (0 = none), memo hash.

```bash
cast send $INVOICES "createInvoice(uint256,address,address,uint256,uint64,bytes32)" \
  $MID $ALICE $USDC 120000000000 0 $(cast keccak "memo-design-job") \
  --rpc-url $RPC --private-key $PK
```

**Expected:** `status 1`. Invoice id is **1**; `export INV=1`. Check it's
payable:

```bash
cast call $INVOICES "isPayable(uint256)(bool)" $INV --rpc-url $RPC
```

**Expected:** `true`.

**2. Alice approves + pays once.**

```bash
cast send $USDC "mint(address,uint256)" $ALICE 200000000000 --rpc-url $RPC --private-key $PK
cast send $USDC "approve(address,uint256)" $INVOICES \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --rpc-url $RPC --private-key $ALICE_PK
cast send $INVOICES "pay(uint256,bytes32)" $INV $(cast keccak "client-nonce-1") \
  --rpc-url $RPC --private-key $ALICE_PK
```

**Expected:** `status 1`. The invoice is now terminal `PAID`:

```bash
cast call $INVOICES "isPayable(uint256)(bool)" $INV --rpc-url $RPC
cast call $USDC "balanceOf(address)(uint256)" $INVOICES --rpc-url $RPC
```

**Expected:** `false` (no longer payable) and `0` (zero custody — the invoice
contract holds nothing).

**3. Try to pay it again — it must revert.**

```bash
cast send $INVOICES "pay(uint256,bytes32)" $INV $(cast keccak "client-nonce-2") \
  --rpc-url $RPC --private-key $ALICE_PK
```

**Expected:** the command **fails** with a revert mentioning
`Access0x1Invoices__NotOpen` (the invoice is `PAID`, not `OPEN`). A double-click
or a malicious replay cannot charge the client twice. Confirm Alice's balance is
unchanged by the failed replay.

### B5. GiftCards — issue → redeem → never-negative

A bakery sells a `$50` gift card. The holder spends it down; an over-redeem
applies only what's left and the balance floors at zero — **never negative**.
This contract holds **no tokens** (it is a pure USD-denominated accounting
receipt), so the whole security surface is the never-negative balance.

**1. Issue a $50 card to Alice** (as the merchant owner). Args: merchant, a card
code hash, recipient, face value `$50` = `5000000000` (8-dp).

```bash
cast send $GIFTCARDS "issueCard(uint256,bytes32,address,uint256)" \
  $MID $(cast keccak "RISE-BDAY-2026") $ALICE 5000000000 \
  --rpc-url $RPC --private-key $PK
```

**Expected:** `status 1`. The card id is deterministic from
`(merchant, code)`. Read the balance — you need the card id; the simplest way is
to capture it from the `issueCard` return via a `cast call` dry-run first:

```bash
cast call $GIFTCARDS "issueCard(uint256,bytes32,address,uint256)(uint256)" \
  $MID $(cast keccak "RISE-BDAY-2026") $ALICE 5000000000 --rpc-url $RPC --from $ME
```

**Expected:** the card id (a large uint). `export CARD=<CARD_ID>`. Now the
balance:

```bash
cast call $GIFTCARDS "balanceOf(address,uint256)(uint256)" $ALICE $CARD --rpc-url $RPC
```

**Expected:** `5000000000` ($50 in 8-dp).

**2. Redeem $20, then $25 — balances step down.** `redeem(cardId, amountUsd8,
redemptionId)`; each `redemptionId` is one-shot.

```bash
cast send $GIFTCARDS "redeem(uint256,uint256,bytes32)" $CARD 2000000000 $(cast keccak "visit-1") \
  --rpc-url $RPC --private-key $ALICE_PK
cast send $GIFTCARDS "redeem(uint256,uint256,bytes32)" $CARD 2500000000 $(cast keccak "visit-2") \
  --rpc-url $RPC --private-key $ALICE_PK
cast call $GIFTCARDS "balanceOf(address,uint256)(uint256)" $ALICE $CARD --rpc-url $RPC
```

**Expected:** `500000000` ($5 left: 50 − 20 − 25).

**3. Over-redeem $40 with only $5 left — applies only $5, never negative.**

```bash
cast send $GIFTCARDS "redeem(uint256,uint256,bytes32)" $CARD 4000000000 $(cast keccak "visit-3") \
  --rpc-url $RPC --private-key $ALICE_PK
cast call $GIFTCARDS "balanceOf(address,uint256)(uint256)" $ALICE $CARD --rpc-url $RPC
```

**Expected:** `status 1` (the checkout is **not** reverted), and the balance is
exactly `0` — the redemption applied only the remaining `$5`, never overdrew. A
further redeem on the empty card applies zero (a clean no-op), still `0`.

**4. Replay guard.** Re-using a spent `redemptionId` reverts:

```bash
cast send $GIFTCARDS "redeem(uint256,uint256,bytes32)" $CARD 1000000000 $(cast keccak "visit-1") \
  --rpc-url $RPC --private-key $ALICE_PK
```

**Expected:** **fails** with `GiftCards__RedemptionUsed` — the same redemption
can never double-debit.

### B6. PaymentLanes — claim

PaymentLanes is the "receive in any coin" receipt ledger (ERC-6909-style). It is
**optional** and off by default. To test it, deploy with it wired:

```bash
DEPLOY_PAYMENT_LANES=true make deploy-local
```

and read the new `PaymentLanes` address from the log. `export LANES=<LANES_ADDR>`
and re-export `$ROUTER`/`$USDC` from this fresh deploy.

When PaymentLanes is wired, a `payToken` routes the merchant's **net** into a
lane the merchant **claims** later (instead of a direct push). After running one
payment through the Router (as in B1) against this wired deploy, the merchant
pulls their funds:

```bash
# The merchant claims their USDC lane (claims the caller's own lane for this asset).
cast send $LANES "claim(address)" $USDC --rpc-url $RPC --private-key $PK
cast call $USDC "balanceOf(address)(uint256)" $ME --rpc-url $RPC
```

**Expected:** `claim` returns `status 1` and the merchant's USDC balance
increases by the net that was credited to the lane. A lane releases **only** the
asset that funded it (the cross-asset firewall); claiming an empty/never-funded
lane reverts `NothingToClaim`. The `credit` side is permissioned — only the
authorized Router can call it — so you exercise it indirectly by running a
payment, not by calling `credit` directly.

### B7. SessionGrant — openSession → spend → revoke

SessionGrant is the "sign once, spend within a budget" ledger that Subscriptions
and Bookings compose. You already opened a real session in B2/B3. Here is the
primitive on its own, with a **direct delegate** so you can call `spend`
yourself.

**1. Open a session where the delegate is Alice** (so Alice can call `spend`).
Budget `$100` (in 8-dp = `10000000000`), far-future expiry:

```bash
cast call $GRANT "openSession(address,uint256,uint64)(bytes32)" \
  $ALICE 10000000000 1900000000 --rpc-url $RPC --from $ME
```

**Expected:** a `0x…` session id. `export SID2=<ID>`, then open it for real
(opened by `$ME`, the owner):

```bash
cast send $GRANT "openSession(address,uint256,uint64)" \
  $ALICE 10000000000 1900000000 --rpc-url $RPC --private-key $PK
cast call $GRANT "remaining(bytes32)(uint256)" $SID2 --rpc-url $RPC
```

**Expected:** `remaining` = `10000000000` ($100 budget).

**2. Spend within budget (Alice, the delegate).**

```bash
cast send $GRANT "spend(bytes32,uint256)" $SID2 4000000000 --rpc-url $RPC --private-key $ALICE_PK
cast call $GRANT "remaining(bytes32)(uint256)" $SID2 --rpc-url $RPC
```

**Expected:** `status 1`, `remaining` = `6000000000` ($60 left).

**3. Over-budget spend reverts (never negative).**

```bash
cast send $GRANT "spend(bytes32,uint256)" $SID2 9000000000 --rpc-url $RPC --private-key $ALICE_PK
```

**Expected:** **fails** with `SessionGrant__BudgetExceeded` — you cannot spend
past the remaining budget; the meter never goes negative.

**4. Revoke (the owner kills the session).**

```bash
cast send $GRANT "revoke(bytes32)" $SID2 --rpc-url $RPC --private-key $PK
cast send $GRANT "spend(bytes32,uint256)" $SID2 1000000000 --rpc-url $RPC --private-key $ALICE_PK
```

**Expected:** the `revoke` succeeds; the follow-up `spend` **fails** with
`SessionGrant__SessionRevoked`. A revoked grant is dead — the agent's authority
is gone.

### B8. Nft — list → buy

`Access0x1Nft` is a fixed-price listing market that settles through the same
Router. It is **not** part of `DeployAll`, so deploy it standalone, pointing it
at your Router. Its constructor is `(address initialOwner, Access0x1Router
router_)`.

**1. Deploy it.**

```bash
cast send --rpc-url $RPC --private-key $PK --create \
  $(forge inspect Access0x1Nft bytecode) \
  "constructor(address,address)" $ME $ROUTER
```

**Expected:** a receipt with a `contractAddress`. `export NFT=<NFT_ADDR>`.

> You also need a test ERC-721 to list. Any mock 721 you control works; the
> automated tests use a mock in `test/mocks/`. The point of this section is the
> **money path** (`buy` settling through the Router), which mirrors B1.

**2. List a token** (as the merchant owner). Args: merchant, collection,
tokenId, paymentToken, price `$10` = `1000000000` (8-dp). The contract **escrows
the NFT** and probes pricing at list time, so a structurally unbuyable listing is
rejected up front.

```bash
cast send $NFT "list(uint256,address,uint256,address,uint256)" \
  $MID <COLLECTION_ADDR> <TOKEN_ID> $USDC 1000000000 \
  --rpc-url $RPC --private-key $PK
```

**Expected:** `status 1` (after you've approved the NFT contract to take your
721). Listing id is **1**; `export LISTING=1`.

**3. Buy it.** `buy(listingId, maxPriceUsd8)` — the `maxPriceUsd8` is slippage
protection (set it `>=` the price). Alice approves USDC to the NFT contract,
then buys:

```bash
cast send $USDC "approve(address,uint256)" $NFT \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --rpc-url $RPC --private-key $ALICE_PK
cast send $NFT "buy(uint256,uint256)" $LISTING 1000000000 \
  --rpc-url $RPC --private-key $ALICE_PK
```

**Expected:** `status 1`. The NFT transfers to Alice, the seller is paid the net
through the Router fee-split, the platform takes its cut, and the NFT contract
holds **zero** payment token after (zero custody, same invariant as B1).

---

## C. Web app — onboarding, checkout, verify, dashboard

The web app (`web/`, Next.js) is the hosted checkout + merchant surface. There
are two ways to run it.

### C1. Start the dev server

```bash
cd web
npm run dev
```

**Expected:** `next dev` boots and prints `Local: http://localhost:3000`. Open
that URL. The root (`/`) **redirects to `/onboard`**.

> **What works without any chain config.** The **onboard branding** screen and the
> **verify** screen are UI flows that do not need an on-chain merchant — you can
> click through them immediately. The **checkout** (`/m/[merchantId]`) and
> **dashboard** read live on-chain data, so they need the app pointed at a chain
> where your Router is deployed (see C5).

### C2. Onboarding — `/onboard`

1. Click **Connect** (top right) and sign in with the Dynamic wallet widget.
2. Under **"Make it yours"**, fill the three plain-English fields: a **name**, a
   **one-line description**, and a **logo**. Watch the live **"Pay {name}"**
   preview update as you type, and the **checkout-link availability** check.
3. (Optional) Set a **checkout mode**, and (optional) raise your **verification
   level**.
4. Click **Save**.

**Expected:** you get a **branded checkout link**, an **embed tag**, and a
**Test-it** button — "live in under two minutes, no code and no gas." No
transaction is sent here (on-chain registration is the Advanced path from the
dashboard). The brand name is stored in `localStorage` (`ax1_merchant_name`) and
the merchant id in `ax1_merchant_id` for the dashboard/checkout to read.

### C3. Checkout — `/m/[merchantId]`

Open `http://localhost:3000/m/1` (use a merchant id that exists on the configured
chain). Optional URL params: `?amount=29.00` (price), `?order=<id>`,
`?return_url=<url>`, `?name=<display name>`.

**Expected:** the white-label **CheckoutCard** loads the merchant record from the
Router, fetches the **live USDC quote** (the same `quote()` you ran in B1), and
shows a **Pay** button. Paying prompts your connected wallet to approve + pay; on
success you see a confirmation (and the `return_url` link if you passed one). If
the merchant id doesn't exist on-chain, you get **"This payment link is not
valid"** (the `Access0x1__MerchantNotFound` path) — exactly the safe failure you
want.

### C4. Verify — `/verify`, and Dashboard — `/dashboard`

- **`/verify`** runs the verification stack (Dynamic wallet + World ID / OIDC,
  depending on which env keys are set). With no keys set, the verification levels
  render but the providers are **fail-soft** (off), so nothing crashes — you see
  the panel, just can't complete a real verification. Set the relevant
  `NEXT_PUBLIC_*` keys in `web/.env` to turn a provider on.
- **`/dashboard`** reads the **last 50 `PaymentReceived` events** for the
  merchant id saved at onboard (from `localStorage`), filtered by your merchant.
  After you run a real payment against the configured chain (C3 or B1 on a chain
  the app points at), refresh the dashboard.

**Expected:** the dashboard shows a **receipt feed** — block, token amount, USD
amount, buyer (truncated), and a tx-hash link (a real explorer link on Base
Sepolia / ZKsync Sepolia; plain text on Arc, whose explorer is intentionally not
hardcoded). An "updated Ns ago" stamp confirms it's live.

### C5. Pointing the web app at your chain

The app supports **Arc Testnet, Base Sepolia, and ZKsync Sepolia** out of the
box. It reads addresses from env (doctrine: never an address from memory). Copy
`web/.env.example` to `web/.env` and set, for the chain you deployed to:

- `NEXT_PUBLIC_DEFAULT_CHAIN_ID` — e.g. `84532` for Base Sepolia.
- `NEXT_PUBLIC_ROUTER_ADDRESS_<chainId>` — your deployed Router.
- `NEXT_PUBLIC_USDC_ADDRESS_<chainId>` — the chain's USDC.
- The chain's `..._RPC_URL` and `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID`.

**Expected:** with those set and a Router deployed to that chain, `/m/<id>` and
`/dashboard` light up with live data. (The on-chain checkout/dashboard flows are
designed for a public testnet, not the local Anvil chain — local Anvil is where
the `cast` walkthroughs in Section B prove the contracts.)

---

## D. The test suites (920 + web gate)

The automated suites are the ground truth behind every manual flow above. Run
them to confirm a clean tree.

### D1. The contract suite — 920 tests

```bash
make test          # or: forge test
```

**Expected:** the final summary line reads roughly
`Ran <N> test suites: 920 tests passed; 0 failed; 0 skipped`. This is the union of:

- **`test/unit/`** — per-function correctness.
- **`test/attack/`** — adversarial / exploit attempts that must fail.
- **`test/invariant/`** + **`test/fuzz/`** — properties proven over random inputs
  (conservation, never-negative, tenant isolation).
- **`test/integration/`** + **`test/scenario/`** — the human-readable end-to-end
  stories (the coffee shop, the SaaS, the salon, the invoice, the gift card).

**How to read it:** every test name describes the property it pins. A green run
means **net + fee == gross**, **zero custody**, **never-negative**, **pay-once**,
and **refund-never-blocked** all hold. If anything is red, the test name tells
you which property broke. Read just the scenario suite (the most readable) with:

```bash
make test-scenario     # forge test --match-path 'test/scenario/*'
```

### D2. The web gate

```bash
cd web && npm run gate
```

This runs, in order: an embed-syntax check, the embed-address verifier, a
TypeScript `tsc --noEmit` typecheck, and the Vitest unit suite (integration tests
excluded).

**Expected:** all four steps pass; the Vitest summary reports roughly **532
passing** across ~50 files. If a suite fails to **load** a module (e.g.
`Cannot find package 'lucide-react'`), that is a missing dependency, not a logic
failure — run `cd web && npm install` and re-run the gate.

### D3. The full gate (both at once)

```bash
make gate
```

**Expected:** contracts build + 920 tests + `forge fmt --check`, then the web
gate, ending in `==> GATE GREEN`. This is the single command that proves the
whole repo is healthy before a commit.

---

## E. Pre-demo smoke checklist

Run this top-to-bottom right before a demo. Each line is a hard gate — if one
fails, stop and fix it before showing anyone.

- [ ] **Tools present.** `forge --version && cast --version && anvil --version`
      all print (Section A1).
- [ ] **Deps installed.** `make install` completed; a bare `make build` exits
      green (Section A3).
- [ ] **Contracts green.** `make test` → `920 passed; 0 failed` (Section D1).
- [ ] **Web green.** `cd web && npm run gate` → all four steps pass, ~768 tests
      (Section D2).
- [ ] **Anvil up.** `make anvil` is running in its own terminal, "Listening on
      127.0.0.1:8545" (Section A4).
- [ ] **Estate deployed.** `make deploy-local` ended with `ONCHAIN EXECUTION
      COMPLETE & SUCCESSFUL` and printed the address block (Section A5).
- [ ] **Money path proven on-chain.** `make drive-local` printed
      `net+fee==gross : true` and `router USDC bal : 0` (Section A6 callout).
- [ ] **One hand-payment.** You ran B1 end to end: a `payToken` succeeded and the
      Router's USDC balance read back **`0`** (zero custody).
- [ ] **A guard bit.** You watched at least one revert on purpose — the
      over-budget `renew` charging nothing (B2 step 6), the second invoice `pay`
      reverting (B4 step 3), or the over-budget `spend` reverting (B7 step 3).
- [ ] **Web demo wired.** `cd web && npm run dev` serves `localhost:3000`,
      `/onboard` loads and Save yields a checkout link + embed tag (Section C2);
      if showing live checkout/dashboard, `web/.env` points at the deployed chain
      (Section C5).
- [ ] **Backup screenshots.** You have a screenshot or recording of the green
      `make test` summary and a successful checkout, in case the live network is
      flaky on demo day.

If every box is checked, you can hand-test any contract on request and walk the
web flow end to end. That is the whole product, provable by eye.
