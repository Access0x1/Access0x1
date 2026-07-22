# Price sources — the swappable oracle seam

`Access0x1Router` prices a USD-denominated charge into the pay-in token **inside the
settlement transaction**, reading the price through a per-asset feed slot. This page is
the architecture of that slot: what it is, the exact interface a price source conforms
to, the source shipped by default, and the drop-in that extends real USD pricing to
chains a single oracle network does not cover.

> **The thesis.** The per-asset feed slot — `priceFeedOf[token]`, typed and read as
> Chainlink's `AggregatorV3Interface` — **is** the price-source interface. Swapping the
> source is one owner call to `setPriceFeed`. There is **no new router address**, **no
> merchant re-registration**, and no change to any pay path — a merchant's record,
> payout, and fee config are untouched, and the source swap is invisible to it.

> **Scope: testnet.** "Live" here means live on a testnet. No mainnet
> ([FAQ → mainnet](./FAQ.md#can-i-run-this-on-mainnet)). Every address traces to a
> committed `broadcast/` record via [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) — an
> address that is not on-chain is not claimed.

---

## The seam

All pricing lives in one place. [`quote()`](../src/Access0x1Router.sol) converts a USD
amount (8 decimals) into a token amount, and both settlement paths (`payNative`,
`payToken`) read the feed through it in-transaction. The slot behind `quote()` is:

- **`priceFeedOf[token]`** — a `mapping(address => address)`, one price source per asset.
  `priceFeedOf[NATIVE]` (`NATIVE == address(0)`) is the native/USD source.
- **`setPriceFeed(token, feed)`** — `onlyOwner`. Points the slot at any conforming
  source and resets `stalenessOf[token] = 0`, so `quote()` falls back to OracleLib's 1h
  default window (`OracleLib.TIMEOUT = 3600`).
- **`setPriceFeed(token, feed, maxStaleness)`** — `onlyOwner`. The same swap plus a
  per-feed staleness window, for a source whose publish cadence differs from 1h.

Because the slot holds an `address` read as `AggregatorV3Interface`, **any contract that
implements the subset of that interface `quote()` actually calls drops straight in.** No
router bytecode changes; the CREATE3 mirror address
`0xe92244e3368561faf21648146511DeDE3a475EB5` is unchanged on every mirrored chain (see
[Deployments](../README.md#deployments)). The abstraction is already in the deployed
contract — this page documents the contract a source honors to occupy the slot safely.

> **Not the ERC-7726 read surface.** The repo also ships
> [`src/PriceOracleAdapter.sol`](../src/PriceOracleAdapter.sol) (ERC-7726 `getQuote`) as a
> **parallel** surface for SDK and off-chain consumers. The router does **not** read it at
> pay time. The pay-path seam is and remains `AggregatorV3Interface`; this page is about
> the seam the money flows through.

---

## The conformance contract

On the pay path the router makes **exactly two calls** on whatever address sits in the
slot. A conforming source satisfies both, because the money-path guards depend on them.

1. **`staleCheckLatestRoundData(feed, maxStaleness)`** →
   [`feed.latestRoundData()`](../src/libraries/OracleLib.sol), then the
   [`OracleLib`](../src/libraries/OracleLib.sol) guard asserts `updatedAt != 0`,
   `answeredInRound >= roundId`, and `block.timestamp - updatedAt <= maxStaleness`.
2. **`feed.decimals()`** — read through the router's `try/catch`; a revert surfaces as
   `Access0x1__TokenNotAllowed`.

Nothing else. `description()`, `version()`, and `getRoundData()` never run on the pay
path — a source implements them for tooling, and the money path stands independent of
them.

### What `latestRoundData()` returns

| Field | Requirement |
|---|---|
| `answer` (`int256`) | The price of one whole unit of the base asset, scaled to exactly `decimals()` decimals. `answer > 0` is a valid price. A non-positive `answer` reaches the router, which reverts `Access0x1__InvalidPrice(answer)` — the source **never** clamps, floors, or substitutes a fallback price. |
| `updatedAt` (`uint256`) | **The real publish time of the underlying price** — the timestamp the source itself stamped the observation with, **never `block.timestamp`.** The staleness guard subtracts `updatedAt` from `block.timestamp`; a source that returns `block.timestamp` reports every price as zero-age and **silently disables the staleness guard**, letting a dead or lapsed source settle real payments. This is the single most important rule on this page. |
| `roundId` / `answeredInRound` (`uint80`) | `answeredInRound >= roundId` holds (equal is fine). A source with no round concept sets both to the same monotonic value (for example the publish time). `answeredInRound < roundId` reads to the guard as a carried-over round and reverts `OracleLib__StalePrice`. |
| `updatedAt == 0` | Reserved by the guard to mean "round never completed" → `OracleLib__StalePrice`. A source that cannot produce a price **reverts** or returns `updatedAt == 0`, never a fabricated non-zero timestamp on a garbage answer. |

### `decimals()`

`decimals()` returns the exact number of decimals `answer` is scaled to, and the two
**stay coherent**. The router computes

```
tokenAmount = usdAmount8 · 10^(feedDecimals + tokenDecimals) / (10^8 · price)   (rounds up)
```

so a `decimals()` that disagrees with `answer`'s true scale mis-prices the payment by
orders of magnitude. Feed decimals and token decimals are read **live** (`feed.decimals()`,
the token's own `decimals()`), never hardcoded — this is what keeps the mixed-decimal case
safe (an 18-decimal native token, a 6-decimal USDC, an 8-decimal feed all reconcile). A
`decimals()` that reverts maps to `Access0x1__TokenNotAllowed`; it never reverts
transiently.

### Every failure is a revert

Every failure mode surfaces as a **revert**, never a zero and never a stale-but-plausible
answer. A reverting `quote()` reverts the whole `payNative` / `payToken` — nothing
settles, the buyer's value is untouched, and refunds are moot because no state changed.
This is the law: *money paths roll back, never swallow.* A price source holds no funds and
has no settlement path of its own — it is a `view` read.

### The exact reverts (from source)

| Revert | Raised when |
|---|---|
| `OracleLib__StalePrice()` | `updatedAt == 0`, `answeredInRound < roundId`, or `block.timestamp - updatedAt > maxStaleness`. |
| `Access0x1__InvalidPrice(int256 answer)` | `answer <= 0` (both zero and negative). |
| `Access0x1__TokenNotAllowed(address token)` | The slot is empty, `feed.decimals()` reverts, the token's `decimals()` reverts, or the token is not allowlisted. |

On the L2 deployments an optional Chainlink **L2 Sequencer Uptime** feed sits in a
separate slot (`sequencerUptimeFeed`); when set, `quote()` also rejects pricing while the
sequencer is down or inside its post-restart grace window (`OracleLib__SequencerDown`,
`OracleLib__SequencerGracePeriodNotOver`). L1 and feed-less chains pass `address(0)` and
skip that check unchanged.

### Conformance matrix (every source passes)

| # | Case | Expected |
|---|---|---|
| C1 | Fresh price, `answer > 0`, coherent decimals | `quote()` returns the correct token amount |
| C2 | `updatedAt = now - (maxStaleness + 1)` | reverts `OracleLib__StalePrice` |
| C3 | `updatedAt == 0` | reverts `OracleLib__StalePrice` |
| C4 | `answeredInRound < roundId` | reverts `OracleLib__StalePrice` |
| C5 | `answer == 0` | reverts `Access0x1__InvalidPrice(0)` |
| C6 | `answer < 0` | reverts `Access0x1__InvalidPrice(answer)` |
| C7 | Known price + decimals | `tokenAmount` matches a hand-computed expected within ≤1 wei (round-up) |
| C8 | `decimals()` reverts | reverts `Access0x1__TokenNotAllowed(token)` |
| C9 | Old publish time, fresh block | reverts `OracleLib__StalePrice` — the guardrail on the `updatedAt` rule; a source returning `block.timestamp` for `updatedAt` fails this case |

---

## Source 1 — Chainlink (the shipped default)

Chainlink `AggregatorV3` feeds are the source `quote()` was written against, and
`priceFeedOf[token]` points at them on every chain that carries one (see
[CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md)). Chainlink is the identity case:

- **zero new code** — no wrapper, no vendored source;
- **the existing green suite is the proof** — the `OracleLib` unit + edge suites and the
  router unit, invariant, and fork suites exercise this path today;
- **no re-deploy, no re-wire** on any chain that already has a Chainlink feed.

Chainlink stays the default. A second source is **additive** — set only on an asset or
chain where no Chainlink feed exists.

---

## Source 2 — a pull oracle via `PythAggregatorV3` (the drop-in)

### Why a pull oracle on testnet

A **pull oracle** publishes **real market prices on testnets** — the same institutional
feed as mainnet, signed off-chain and made available on-demand. A **DEX time-weighted
average (TWAP)** on a testnet is **noise**: testnet pools carry no liquidity and see no
arbitrage, so the last trade is not a price — it is whatever the last faucet-funded actor
happened to swap. The coverage gap (chains beyond a push-feed network's reach) is
therefore closed by a pull oracle, not by a DEX oracle. A DEX-TWAP source is mainnet-path
code — honest only where a deep, arbitraged pool exists — and never priced against on
testnet.

### The contract

Pyth's **`PythAggregatorV3`** already implements `AggregatorV3Interface` over `IPyth`, so
it **is** the drop-in — exactly the shape `priceFeedOf` consumes. It conforms to the
contract above by construction:

- **`updatedAt = price.publishTime`** — the real publish time, never `block.timestamp`.
- **`decimals() == -expo`** — a Pyth price carries an `expo`; `answer` is the mantissa, so
  the decimal count is `-expo`. Coherence (C7) is asserted at deploy against the live
  feed's actual expo.
- **`answer = int256(price.price)`**, with `roundId == answeredInRound == updatedAt`, so
  the completed-round checks hold (equal, non-zero).

One instance is deployed per `(chain, asset)` from the chain's Pyth contract and the
pair's price-feed id — both read from Pyth's official docs and verified on-chain **before**
`setPriceFeed`, never invented from memory ([CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md)
records the source of every address). The value added here is the **conformance test plus
the wiring**, not novel oracle code — the adapter is vendored and attributed in its header,
pinned to an upstream commit.

### The update leg — two modes

Pyth is a **pull** oracle: `PythAggregatorV3.latestRoundData()` is a `view` that returns
the **last price pushed on-chain**. Fresh data requires someone to have called
`updatePriceFeeds` with a signed update. This is the design axis, and it has two modes.

**Mode (a) — keeper-push (the first landing).** An off-chain worker pulls signed updates
and calls `updatePriceFeeds` on a cadence-plus-deviation trigger — the operational shape
of a Chainlink Automation upkeep.

- **No money-path change.** `quote()`, `payNative`, and `payToken` are byte-identical to
  today; the router only ever does its normal `view` read of the last on-chain price. The
  router never calls `updatePriceFeeds` and never touches an update fee.
- **The staleness guard is the safety net.** Set `setPriceFeed(asset, source, maxStaleness)`
  with `maxStaleness = pusher cadence + margin` (the 3-arg overload — the blind 1h default
  is wrong for a cadence you chose). A stalled pusher ages the price past `maxStaleness`,
  and `quote()` **correctly vetoes** with `OracleLib__StalePrice`: the payment reverts
  clean, nothing settles, no bad price is paid against. A quiet feed degrades to "cannot
  pay right now," never "paid at a wrong price."

**Mode (b) — in-tx update (a separate, deliberately-gated design).** The payer submits the
signed update **and its fee** in the same transaction, guaranteeing a fresh price at
settlement. This is specified, not shipped, because it changes the router surface:

- **It needs a new payable entry point.** `quote()` is a `view` and cannot call the
  state-changing `updatePriceFeeds`, so mode (b) requires a new payable variant (for
  example `payNativeWithPythUpdate(..., bytes[] updateData)`), **not** an edit to the
  existing pay paths. A new surface breaks the "no router change / zero-redeploy" property
  by definition — hence its own gate: new tests, red-team, security review, and audit
  delta.
- **The update fee never mixes into the payment.** Compute `pythFee =
  getUpdateFee(updateData)`. The payment budget is `msg.value - pythFee`; the underpaid
  check compares **that** against `gross`, never the raw `msg.value`. The update fee is
  spent to the Pyth contract as the first interaction inside `nonReentrant`, and is
  **excluded** from gross, from the fee split, and from the merchant's net. A refund is
  computed on `(msg.value - pythFee) - gross` — the payer is refunded their payment excess,
  never charged the update fee twice, and never refunded the spent fee.
- **Refunds stay unblocked.** The update push is the *first* interaction, so a Pyth-side
  revert aborts before any effect — no settled receipt is ever rolled back.

Mode (a) ships the coverage win at zero router risk and zero re-audit. Mode (b) is a UX
refinement (per-transaction freshness) that knowingly trades the zero-redeploy property
for a router surface change, and is scoped as its own unit.

---

## Why more than one source — the coverage rationale

One mirrored router address lives on many chains ([Deployments](../README.md#deployments)).
No single oracle network covers every one of them, so the seam carries price sources beyond
any one network. Per [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md), the deployed chains that
carry **no wired Chainlink feed** are:

| Chain | id | Pricing path today |
|---|---|---|
| Arc Testnet | 5042002 | No Chainlink feed on Arc; prices via the deployed `$1.00` USDC/USD mock. |
| Celo Sepolia | 11142220 | USDC allowlisted but **unpriced** until a feed is set. |
| Robinhood | 46630 | On Chainlink's faucet list, **no wired push feed** — bare deploy. |
| Ethereum Hoodi | 560048 | On Chainlink's faucet list, **no wired push feed** — bare deploy. |
| 0G Galileo | 16602 | **No Chainlink or Pyth feed published** — bare deploy. |
| Tempo (Moderato) | 42431 | Special-cased: USD-denominated fees, no native gas token — a separate track. |

The chains that **do** carry a Chainlink feed (Base Sepolia, Ethereum Sepolia, Optimism
Sepolia, Avalanche Fuji, Arbitrum Sepolia, ZKsync Sepolia) stay on the default and need no
adapter. The pull-oracle drop-in is what turns real USD pricing on for a chain in the first
group where a pull feed exists — one owner `setPriceFeed`, no redeploy — while a chain with
no first-party-confirmed source stays **bare** (token-amount only) until a source is wired.
A source is never stood in from memory (an address that is not on-chain is not claimed).

---

## See also

- [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) — the source of truth for every live address,
  chain id, USDC, and feed.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the contracts fit together, the money spine.
- [OPTIONAL-SEAMS.md](./OPTIONAL-SEAMS.md) — the other env-gated, fail-soft seams.
- [`src/Access0x1Router.sol`](../src/Access0x1Router.sol) · `quote()` and `setPriceFeed`.
- [`src/libraries/OracleLib.sol`](../src/libraries/OracleLib.sol) · the staleness guard.
