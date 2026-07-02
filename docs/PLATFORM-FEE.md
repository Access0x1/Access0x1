# Platform fee — what the rail charges, exactly

Access0x1 takes a **platform fee on every settlement**. This page is the full
disclosure: the rate, where it goes, the exact arithmetic, and what you (the
integrator or merchant) can and cannot change. No surprises at settle time —
everything here is a public on-chain value you can verify yourself.

## The rate and where it goes

- **`platformFeeBps` — default `100` bps = 1%.** Set by the protocol owner via
  [`setPlatformFee`](../src/Access0x1Router.sol), hard-capped at
  `MAX_FEE_BPS = 1000` bps (10%) — the owner can never set a confiscatory rate.
- **`platformTreasury` — the deploy wallet.** The fee leg settles to the
  platform treasury address, set via [`setTreasury`](../src/Access0x1Router.sol)
  (non-zero enforced). On the testnet mirror set this is the canonical deployer
  wallet (see [MIRROR-CUTOVER.md](./MIRROR-CUTOVER.md) and
  [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md)).

Both are **public getters on the router** — `platformFeeBps()` and
`platformTreasury()` — so any integrator can read the live policy before (or
inside) a transaction. Every change emits `PlatformFeeUpdated` /
`TreasuryUpdated`, so the history is on-chain too.

## How a payment splits

For a gross settlement amount `X` (in the pay-in asset's own units):

```text
platformFee = X * platformFeeBps / 10_000   // floored (Math.mulDiv)
merchantFee = X * feeBps         / 10_000   // your optional surcharge, floored
net         = X - platformFee - merchantFee // what your payout address receives
```

- `net + platformFee + merchantFee == X` holds **exactly** — no dust is lost,
  nothing is double-counted, and any rounding remainder from the flooring stays
  with the **merchant**, never the platform.
- The platform leg always lands at `platformTreasury`; a merchant cannot
  redirect it. Your surcharge leg lands at your `feeRecipient` (or your
  `payout` if unset).
- Each `PaymentReceived` event discloses `grossAmount`, `feeAmount`
  (platform + surcharge combined) and `netAmount` per payment, so every split
  is auditable from the logs.

## Read live, not baked in

The fee is **read at settlement time, on-chain, every time**:

- The router's pay paths (`payNative` / `payToken`) read the current
  `platformFeeBps` inside the settlement transaction.
- The escrow ([`Access0x1Escrow`](../src/Access0x1Escrow.sol)) never copies the
  rate: on release it reads the router's **live** `platformFeeBps()` and
  `platformTreasury()`. A deposit held across a fee change settles at the rate
  in force **at release**, not at open. Escrow releases apply the platform leg
  only (your merchant surcharge is not charged on an escrow release), and a
  **refund always returns the full deposit — no fee is ever taken on a refund**.

## Your own fee on top

Merchants may stack their own surcharge:

- Set `feeBps` at [`registerMerchant`](../src/Access0x1Router.sol) or later via
  `updateMerchant` — in basis points, routed to your `feeRecipient`.
- **The combined fee is capped:** `feeBps + platformFeeBps ≤ MAX_FEE_BPS`
  (1000 bps = 10%), enforced at registration, on every config update, and on
  every platform-fee change.
- Buyer protection is unconditional: if a later platform-fee change would push
  an existing combination past the cap, the **merchant surcharge is trimmed at
  pay time** — the buyer's total never exceeds 10%, and the platform cut is
  never inflated by it.

## Verify it yourself

- Read the live values: `cast call $ROUTER "platformFeeBps()(uint16)"` and
  `cast call $ROUTER "platformTreasury()(address)"` (router addresses:
  [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md)).
- The exactness proof is in the test suite:
  [`test/unit/PlatformFeeSplit.t.sol`](../test/unit/PlatformFeeSplit.t.sol)
  asserts the `mulDiv` split, the `fee + net == gross` conservation, the
  `fee = 0` / `fee = MAX_FEE_BPS` edges, tiny/odd-amount rounding, and the
  stacked-surcharge cap — on both the router and escrow settle paths.
- The fee-bound invariants are documented in [INVARIANTS.md](./INVARIANTS.md)
  and the split walk-through in
  [ARCHITECTURE.md §1.3](./ARCHITECTURE.md#13-the-fee-split--net--fee--gross-exactly).
