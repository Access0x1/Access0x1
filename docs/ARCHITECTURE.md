# Architecture — the Access0x1 money spine

This is the "how it actually works" companion to
[GETTING-STARTED.md](./GETTING-STARTED.md). It walks the contracts in the order
value flows through them, with links straight to the source. Every claim here is
anchored to a line in [`src/`](../src) — read the code next to the prose.

> **One sentence:** a buyer calls one function on one shared router; the router
> reads a USD price from Chainlink *in the same transaction*, splits the payment
> into `net` (merchant) and `fee` (treasury) with `net + fee == gross`, forwards
> both, and keeps nothing.

```
                       ┌─────────────────────────────────────────────┐
   buyer  ── pay ────▶ │              Access0x1Router                 │
  (USD price)          │  quote() ◀── Chainlink feed (read in-tx)     │
                       │     │         guarded by OracleLib (staleness)│
                       │     ▼                                         │
                       │  split:  net + fee == gross                  │
                       └───────┬───────────────────────┬─────────────┘
                               │ net                   │ fee
                               ▼                        ▼
                         merchant payout          platform treasury
                       (router balance ≈ 0 afterward — zero custody)
```

Everything else — subscriptions, bookings, invoices, gift cards, cross-chain
lanes — **composes** this spine. None of them re-derive fee math; they all settle
through the router's pay path.

---

## 1. `Access0x1Router` — the heart

[`src/Access0x1Router.sol`](../src/Access0x1Router.sol) is the product: a single
shared, multi-tenant contract that every merchant registers into. It is
[`Ownable2StepUpgradeable` + `PausableUpgradeable` + UUPS](../src/Access0x1Router.sol#L48).

### 1.1 `quote()` — USD priced inside the transaction

[`quote(merchantId, token, usdAmount8)`](../src/Access0x1Router.sol#L524) converts
a human USD amount (8-decimal fixed point) into the exact token amount to charge,
by reading a Chainlink price feed **in the same call that will move the money**.
There is no off-chain price to trust or replay — the price and the payment are
atomic. This is the Chainlink "Connect-the-World" property: the feed read is part
of the settlement, not a hint passed in by the client.

The feed read is guarded — see [§2 OracleLib](#2-oraclelib--the-staleness-guard).

### 1.2 `payNative()` / `payToken()` — the settlement

- [`payNative(merchantId, usdAmount8, orderId)`](../src/Access0x1Router.sol#L665)
  — pay in the chain's native asset.
- [`payToken(merchantId, token, usdAmount8, orderId)`](../src/Access0x1Router.sol#L718)
  — pay in an allowlisted ERC-20 (e.g. real USDC).

Both are `nonReentrant` + `whenNotPaused`, and both price the charge through
`quote()` first, so the buyer always pays the current USD-equivalent.

### 1.3 The fee split — `net + fee == gross`, exactly

The platform cut (`platformFeeBps`) always settles to the platform treasury; the
merchant's optional surcharge (`feeBps`) settles to the merchant's fee recipient;
the remainder is the merchant's `net`. The arithmetic is documented to hold
exactly — [`net = gross - platformFee - merchantFee` and
`net + platformFee + merchantFee == gross`](../src/Access0x1Router.sol#L592). Both
fees are bounded: [`feeBps + platformFeeBps ≤ MAX_FEE_BPS` (1000 = 10%)](../src/Access0x1Router.sol#L81),
enforced at [`registerMerchant`](../src/Access0x1Router.sol#L299) and on every
fee change, so the platform can never set a confiscatory fee.

### 1.4 Zero custody + fee-on-transfer rejection

The router is a pass-through, not a wallet — its balance is ≈ 0 after every
settlement. Two mechanisms keep it honest:

- **Fee-on-transfer reject:** token pulls measure the *actual* received amount by
  balance delta and revert if a token skimmed it —
  [`received != amount ⇒ Access0x1__FeeOnTransferToken`](../src/Access0x1Router.sol#L650).
  A deflationary token can't desync the fee math.
- **Rescue, not custody:** a failed native push is credited to a pull-map and
  reclaimed via [`claimRescue()`](../src/Access0x1Router.sol#L798), which follows
  Checks-Effects-Interactions (zeroes the credit *before* the call) and is
  `nonReentrant`. The only router-held balance is this explicit failure escrow.

### 1.5 Admin — fat-finger-safe, freezable

The owner is `Ownable2Step` (a two-step handshake — a mistyped transfer can't
brick admin) and is also the UUPS upgrade admin. The proxy address is permanent;
the implementation is swappable via `upgradeToAndCall` **until** the owner calls
`renounceOwnership()`, which freezes the code forever. `Pausable` gates *new*
payments without ever freezing in-flight settlement or refunds.

---

## 2. `OracleLib` — the staleness guard

[`src/libraries/OracleLib.sol`](../src/libraries/OracleLib.sol) is the single
source of truth for "is this price fresh enough to settle on." It wraps
Chainlink's `latestRoundData()` and reverts when the round is stale or
incomplete:

- [`TIMEOUT = 3600`](../src/libraries/OracleLib.sol#L35) (1 hour) — older than this ⇒ revert.
- `updatedAt == 0` ⇒ the round never completed ⇒ revert.
- `answeredInRound < roundId` ⇒ the answer was carried over ⇒ revert.

It is single-responsibility (staleness only; `quote()` owns the `answer > 0`
check) and is *linked*, not deployed — there is no separate staleness constant in
the router. The guard is adapted from the Cyfrin / Patrick Collins pattern.

---

## 3. `SessionGrant` — the spend budget

[`src/SessionGrant.sol`](../src/SessionGrant.sol) is the never-negative spend
meter: a buyer pre-authorizes a budget, and downstream contracts draw against it
without re-prompting the wallet each time. It's the primitive that makes recurring
and metered commerce (below) possible without custody.

---

## 4. The commerce quartet — composition, not re-implementation

Four contracts turn the spine into real merchant products. **Each composes the
Router + SessionGrant** — none re-derives fee math; all settle through
`payToken` / `payNative` and price in-tx via `router.quote`:

| Contract | What it adds |
| --- | --- |
| [`Access0x1Subscriptions`](../src/Access0x1Subscriptions.sol) | Recurring USD billing drawn against a SessionGrant budget — the never-negative meter. |
| [`Access0x1Bookings`](../src/Access0x1Bookings.sol) | Deposit-escrow with a **never-blockable refund** — the stale-oracle resolution leg keeps the refund unconditional. |
| [`Access0x1Invoices`](../src/Access0x1Invoices.sol) | Pay-once payment requests. |
| [`Access0x1GiftCards`](../src/Access0x1GiftCards.sol) | Prepaid USD balance + coupons, hard never-negative. |

Because they reuse the spine, the same invariants (`net + fee == gross`, zero
custody, USD-priced settlement) hold for every product automatically.

---

## 5. `PaymentLanes` — owned-standard ERC-6909 lanes

[`src/PaymentLanes.sol`](../src/PaymentLanes.sol) is the multi-asset
differentiator: ERC-6909 lanes track per-asset balances with conservation
invariants (proven by fuzz tests). It's the foundation the cross-chain stretch
(CCIP/CCT) builds on.

## 6. `ChainRegistry` — O(1) multi-chain

[`src/ChainRegistry.sol`](../src/ChainRegistry.sol) is an O(1) hash-map chain
registry (`addChain`, one SLOAD) so **one** shared router serves every chain
rather than N bespoke deploys. The protocol is live + Blockscout-verified on Arc
Testnet (`5042002`) and Base Sepolia (`84532`) — see
[docs/CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) for the authoritative address
list (never hardcode one; confirm on the explorer).

## 7. `Access0x1Receiver` — notified settlement (CRE)

[`src/Access0x1Receiver.sol`](../src/Access0x1Receiver.sol) is the Chainlink CRE
audit consumer — a forwarder-trusting receiver for off-chain notifications fired
from the router's payment event ("Notified Settlement").

---

## Upgradeability — read this before you read storage

**All system contracts are UUPS-upgradeable.** Each is an implementation behind an
`ERC1967Proxy`, with an `initialize()` that mirrors the old constructor,
`_authorizeUpgrade` gated `onlyOwner`, a `uint256[50] __gap` reserved for future
storage, and reentrancy via the storage-less `ReentrancyGuardTransient`. The
**proxy** is the permanent address; the implementation is swappable until
`renounceOwnership()` freezes it. Practical consequence for contributors: **never
reorder or remove existing storage variables** — only append, and only into the
gap. The committed layout is [docs/STORAGE-LAYOUT.md](./STORAGE-LAYOUT.md).

## The security floor — invariants

The money path is held to fuzz invariants (the router money invariants +
PaymentLanes conservation + the cross-asset firewall), run with thousands of
calls at zero reverts. The formal write-up and the triaged static-analysis
results (slither / aderyn) live in [audit/REPORT.md](../audit/REPORT.md) and
[audit/FINDINGS.md](../audit/FINDINGS.md); the posture summary is
[SECURITY.md](../SECURITY.md).

---

## Read-the-source map

| Want to read… | Start here |
| --- | --- |
| The whole money spine | [`src/Access0x1Router.sol`](../src/Access0x1Router.sol) |
| The staleness guard | [`src/libraries/OracleLib.sol`](../src/libraries/OracleLib.sol) |
| The spend budget | [`src/SessionGrant.sol`](../src/SessionGrant.sol) |
| A real merchant product | [`src/Access0x1Bookings.sol`](../src/Access0x1Bookings.sol) |
| Multi-asset lanes | [`src/PaymentLanes.sol`](../src/PaymentLanes.sol) |
| The React SDK that calls all this | [`packages/react/src/index.ts`](../packages/react/src/index.ts) |
| The full contract surface + Router API | [README.md](../README.md) |
