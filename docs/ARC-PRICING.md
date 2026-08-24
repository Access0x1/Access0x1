# Arc pricing — the two paths, and the runbook for each

Arc testnet (`5042002`) is the hosted checkout's default chain and carries **real Circle
USDC**. Chainlink publishes **no** USDC/USD Data Feed and **no** Data Streams verifier
there — checked against `docs.chain.link/data-feeds/price-feeds/addresses` and
`docs.chain.link/data-streams/supported-networks` on **2026-08-23**, both returning zero
entries for "Arc" or "5042002". So the router has no DON-backed source to price USDC
against on that chain, and something has to fill the slot.

This page documents the two things that can fill it, what each one honestly earns, and the
exact commands the owner runs. Both are **testnet-only**. Mainnet stays owner-run and
audit-gated ([FAQ → mainnet](./FAQ.md#can-i-run-this-on-mainnet)).

> **The seam itself** — `priceFeedOf[token]`, `setPriceFeed`, and the conformance contract a
> price source honors — is documented in [PRICE-SOURCES.md](./PRICE-SOURCES.md). This page is
> the Arc-specific instance of it.

---

## What was there before, and why it was replaced

The slot held [`test/mocks/MockV3Aggregator.sol`](../test/mocks/MockV3Aggregator.sol) — a
**test mock deployed as live pricing infrastructure**. Two defects, both structural:

1. **Staleness was permanent.** The mock's only refresh is its constructor. `OracleLib`'s
   default window is 3600s, so the feed was fresh at deploy and dead an hour later, with
   nothing scheduled to refresh it. `quote()` reverts `OracleLib__StalePrice()` on Arc.
2. **Writes were unguarded.** `updateAnswer(int256)` is `public` with **no access control**,
   and `setRoundData(...)` is `external` with none either — the latter accepting a forged
   `updatedAt`. Anyone could set the price the router settles against, to any value, and make
   it look freshly posted.

Defect 1 fails closed (a stale price refuses to settle, which is correct behaviour landing
for the wrong reason). Defect 2 does not: on a chain with real USDC that is a price-oracle
takeover. Both are closed below.

### Measured on-chain, 2026-08-23 (read-only `cast call`, public Arc RPC)

Reproduce every row; nothing here is inferred.

| Read | Result |
|---|---|
| `description()` on `0xdea2b9d6…7D86B3` | `"MockV3Aggregator"` — it **is** the test mock |
| `latestRoundData()` | roundId `2`, answer `1e8`, updatedAt `1784582793` (2026-07-20T21:26:33Z) |
| `router.priceFeedOf(USDC)` | `0xDea2B9d6…7D86B3` |
| `router.priceFeedOf(NATIVE)` | `0xDea2B9d6…7D86B3` — the **same** mock prices both slots |
| `router.stalenessOf(USDC)` | `604800` (7 days — a per-feed override, not the default) |
| `router.stalenessOf(NATIVE)` | `0` → falls back to `OracleLib.TIMEOUT` = 3600s |
| `router.nextMerchantId()` | `2` — one merchant registered and live |
| `router.quote(0, USDC, 1e8)` | **reverts `0xc4a1093a`** |
| `router.quote(0, NATIVE, 1e8)` | **reverts `0xc4a1093a`** |

`0xc4a1093a` is `OracleLib__StalePrice()` (`cast sig`). Arc chain time at the read was
`1787516680`, so the answer was **2,933,887s / 33.96 days old** — 4.85× past the USDC slot's
7-day window and 815× past the native slot's 1-hour one. **Arc cannot quote at all right now,
on either path, with a merchant registered and waiting.**

Three corrections to what was reported before this measurement, recorded rather than quietly
fixed:

- `latestRoundData()` does **not** return zeros. It returns a live `$1.00` at round 2.
- **Round 2 means the unguarded `updateAnswer` was already called once after deployment** —
  the constructor posts round 1. The open write path is not theoretical; it has been used.
- The blast radius is **wider** than the USDC slot alone: the same mock is also the native/USD
  source, and Arc's native gas token is USDC-denominated.

> **A wiring detail that changes behaviour.** The 2-argument `setPriceFeed(token, feed)` used
> in the runbook below **resets `stalenessOf[token]` to 0**, so the USDC slot drops from its
> current 7-day override back to the 1-hour default. That is the intended direction here — a
> keeper-refreshed feed on a 1800s heartbeat wants the tight window, and a 7-day window on a
> keeper-refreshed feed would let a week-old price settle. Use the 3-argument overload only
> with a deliberate, documented number — which is exactly what **Path B requires**, because a
> relay reports the SOURCE feed's timestamp on a 24h heartbeat rather than its own posting
> time. The number, and the arithmetic behind it, are in
> [Path B's reconciliation table](#-cadence-and-staleness--the-reconciliation-path-b-needs).

The test mock **stays in `test/`** and stays unguarded, which is right: forging arbitrary
rounds is exactly what the router's stale/invalid-round branches need exercised against. What
changed is that nothing in `test/` gets deployed as production pricing any more.

---

## Path A — `OperatorFeed` (the honest stand-in)

[`src/OperatorFeed.sol`](../src/OperatorFeed.sol) is an access-controlled
`AggregatorV3Interface` whose answer is posted by a named operator.

**Label: built, deploy-ready. Not a Chainlink product.** There is no decentralized oracle
network behind the number, no aggregation across node operators, no economic security. One
key posts it. The contract's `description()` says so on-chain, and `version()` returns `0`
so a consumer gating on a real aggregator version rejects it.

What it adds over the mock:

| Guard | What it refuses |
|---|---|
| **Write access** | Everyone except `owner` and one named `operator`. The keeper's hot key is deliberately not the owner key. |
| **Immutable price band** | Any answer outside the deploy-time range (±5% of the peg on Arc). A stolen operator key still cannot post `$1000`. |
| **Declared heartbeat** | Nothing — it is a published cadence (`heartbeat()`, `isStale()`, `secondsSinceUpdate()`) so the keeper reads its schedule from the contract rather than from a runbook that drifts. |
| **No round forgery** | There is no `setRoundData`. `updatedAt` is always `block.timestamp`; `answeredInRound` is always the round just written. |

### Fail-closed, and what happens when the keeper stops

Nothing freezes. Three layers, in order:

1. The keeper stops → `updatedAt` stops advancing. The last answer is not re-blessed as
   valid; it simply ages.
2. Age crosses the router's window for that token → `OracleLib` reverts
   `OracleLib__StalePrice()` inside `quote()`.
3. `quote()` reverting aborts `payNative` / `payToken` **before any value moves**, because
   the router reads the feed **in** the settlement transaction, not from a cached preview.

**An unattended feed refuses payments. It never settles one at a wrong price.** Proven in
`test_payTokenRevertsRatherThanSettlingAgainstAStaleFeed` — the buyer's balance and the
merchant's balance are both asserted unchanged after the revert.

> ⚠ **That sentence is scoped to the UNATTENDED case, and covers only that case.** Read it as
> a guarantee for the design as a whole and it becomes false, because the ATTENDED case has
> the opposite exposure — and a running keeper is exactly what makes a feed attended. See
> the next section, which is the more important half of this page.

### ⚠ The attended case — the danger a keeper introduces

A keeper that re-posts a number **nobody measured** refreshes `updatedAt` on every tick. The
answer is then forever fresh in TIME and arbitrarily wrong in SUBSTANCE, and the staleness
guard — the single mechanism this whole design leans on — is precisely what such a keeper
defeats. Nothing downstream catches it:

- The **band does not help.** It bounds a *malicious* operator; a constant poster sits inside
  any band that contains the peg, so `$1.00` is always admissible.
- The **router does not help.** `quote()` sees a positive answer with an age near zero. Every
  check passes.
- The **merchant absorbs the whole divergence**, on every payment, silently, forever. An
  overstated price yields too few tokens for the same USD amount:
  `tokenAmount = usd · 10^(fd+td) / (1e8 · price)`.

So the exposure inverts. An UNATTENDED feed refuses payments; an ATTENDED feed whose keeper
posts an unmeasured number **settles every payment at a wrong price**. The second failure is
strictly worse than the first, and it is the quiet one.

`script/RefreshOperatorFeed.s.sol` is written against exactly that. It carries **no default
answer at all** and runs in two modes:

| Mode | Env | What the number is | Correct use |
|---|---|---|---|
| **SOURCE** | `OPERATOR_FEED_SOURCE_RPC` + `OPERATOR_FEED_SOURCE` | A real Chainlink aggregator's `latestRoundData()`, read across a fork of the source chain and rescaled to the destination feed's decimals | **The cron.** A decentralized oracle network measured it. |
| **MANUAL** | `OPERATOR_FEED_ANSWER` | One explicit number the operator typed | ONE attended post. Every run prints a banner saying the number tracks no market. **Never a cron.** |

Neither configured, and a run that finds the answer due **reverts**. A keeper that cannot run
unattended beats one that lies quietly, and `make refresh-operator-feed-arc` refuses to start
without a source for the same reason.

**What `updatedAt` attests, exactly.** The `OperatorFeed` timestamp is the POSTING time on Arc,
never the measurement time on the source chain. SOURCE mode therefore bounds the source's own
age separately, against `OPERATOR_FEED_SOURCE_MAX_AGE`, prints it on every run, and posts
nothing once the source passes that limit — at which point the Arc feed ages out and the rail
closes. Fail-closed on both legs.

**The source, and where its numbers come from.** Ethereum Sepolia USDC/USD,
`0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E` — the same feed Path B relays. Confirmed
2026-08-23 two ways: Chainlink's own reference data directory gives it `decimals: 8`,
`heartbeat: 86400`, `threshold: 1` (%); and a direct read returned `description() = "USDC / USD"`,
`version() = 4`, `answer = 99995000`, with the last six rounds landing **86412–86436s** apart.

| Number | Value | Why |
|---|---|---|
| `OPERATOR_FEED_SOURCE_MAX_AGE` | **90000s** | The source's 86400s heartbeat plus a 1h grace. The bare heartbeat is the wrong number: the observed publish interval runs 86412-86436s, so a 86400 limit refuses the source for the ~12-36s each day between the limit expiring and the next round landing. An hour of grace removes the edge entirely. |
| Never use here | `OracleLib.TIMEOUT` (3600s) | A 24h-heartbeat source can never satisfy it. That number closes the rail roughly 23 hours a day. |
| Arc feed heartbeat | 1800s | Unchanged. The Arc feed re-posts far more often than the source moves; that is what keeps the *destination* answer inside the router's 3600s window. |

### Cadence, and why these numbers

| Number | Value | Why |
|---|---|---|
| Router staleness window | 3600s | `OracleLib.TIMEOUT`, the default `setPriceFeed` leaves in place. |
| Feed heartbeat | 1800s | Half the window. One missed tick still leaves the feed inside the router's window. |
| Keeper refresh threshold | 900s | Half the heartbeat (`RefreshOperatorFeed`'s default). |
| Cron interval | 5 min | Finer than the threshold on purpose. A run that finds the answer fresh costs one `eth_call` and exits. |

That is a 4× margin: three consecutive missed cron runs still leave the feed usable. Only a
keeper absent for a full hour reaches the cliff — at which point the rail closes rather than
mispricing.

---

## Path B — the CCIP price relay (the Chainlink-backed one)

Two contracts that carry a **real Chainlink Data Feed answer** from a chain that has one to a
chain that does not:

- [`src/PriceRelaySender.sol`](../src/PriceRelaySender.sol) on **Ethereum Sepolia**, which
  has a real Chainlink USDC/USD aggregator. It reads that feed through the same `OracleLib`
  guard the router uses and forwards the answer as a **data-only** CCIP message.
- [`src/PriceRelayReceiver.sol`](../src/PriceRelayReceiver.sol) on **Arc**. It is itself an
  `AggregatorV3Interface`, so wiring it is the ordinary
  `router.setPriceFeed(usdc, receiver, maxStaleness)` call — **no router change, no new branch,
  no second pricing path to audit.** Use the **3-arg** overload; the 2-arg one closes this rail,
  for the reason worked out in [the reconciliation below](#-cadence-and-staleness--the-reconciliation-path-b-needs).

**Label: built, tested, deploy-ready. Never run on-chain yet.** No broadcast, no live message,
no `messageId`. Do not describe it as live until a real relay lands and the tx is recorded.

**What it earns, stated exactly:** the number pricing a payment on Arc is a real Chainlink
Data Feed answer carried over real Chainlink CCIP infrastructure. It is **not** a Chainlink
Data Feed *on Arc*, and no copy should ever say so.

### The infrastructure, and the one unconfirmed piece

Confirmed in Chainlink's own CCIP directory (`docs.chain.link/ccip/directory/testnet/chain/arc-testnet`,
2026-08-23):

| Fact | Value |
|---|---|
| Arc Testnet CCIP Router | `0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8` (v1.2.0) |
| Arc Testnet chain selector | `3034092155422581607` |
| Lane | Bidirectional with Ethereum Sepolia; onRamp + offRamp live in both directions |
| Registered token pools | `0` |

Zero token pools is irrelevant here: this message carries no tokens.

> **UNCONFIRMED.** Chainlink documents Data / Tokens / Data+Tokens as three independently
> configured message modes. The availability of the **data-only** mode on this specific lane
> is *inferred* from the live ramp infrastructure plus that taxonomy — not from a page
> asserting it for this lane by name. **Confirm with one read call before treating the relay
> as operational:** `PriceRelaySender.quoteFee(...)` is exactly that call, and a Router that
> quotes the message is a Router that accepts it.

### The four receiver guards

CCIP guarantees authenticated, exactly-once **delivery**. It guarantees nothing about whether
the number inside is a correct price — that is the sending contract's job, which is why the
sender reads an immutable aggregator rather than accepting a caller-supplied value. The
receiver then re-checks everything independently:

1. **Lane** — only the configured CCIP Router may call, and only for an allowlisted
   `(sourceChainSelector, sender)` **pair**. Keyed by selector because CREATE3 makes identical
   addresses across chains ordinary.
2. **Scale** — `sourceDecimals` must equal the pinned deploy-time value. The router divides by
   `10 ** decimals()`, so a drifting scale is a silent 100× mispricing.
3. **Monotonicity** — the source timestamp must strictly advance. A replayed or reordered
   report can never walk the price backwards.
4. **Age + band** — a report already too old on arrival never becomes the live price, and an
   answer outside the immutable band is refused outright.

This receiver **reverts** on a bad report, where
[`Access0x1CcipReceiver`](../src/Access0x1CcipReceiver.sol) deliberately credits instead. The
difference is that this message carries no tokens, so a revert strands nothing. The previous
good answer stays in place and keeps aging.

### The timestamp it reports

The **source feed's** `updatedAt`, not the arrival time. Reporting arrival would launder relay
latency into apparent freshness — hiding exactly the failure a staleness guard exists to
catch. It is clamped down to the arrival timestamp so a source chain running ahead of Arc's
clock cannot underflow `OracleLib`'s subtraction; `sourceUpdatedAt()` exposes the raw value
for anyone auditing skew.

### ⚠ Cadence and staleness — the reconciliation Path B needs

That honest timestamp is exactly why Path B needs its own reconciliation, and the deploy
defaults plus the plain 2-arg `setPriceFeed` do **not** add up. Wire it that way and the rail
is **closed roughly 23 hours a day** — it fails closed, so nothing mis-settles, and it is also
simply non-functional. The runbook below uses the numbers worked out here instead.

The arithmetic, end to end:

| Number | Value | Where it comes from |
|---|---|---|
| Source heartbeat — Sepolia USDC/USD | **86400s** | Chainlink's own reference data directory: `heartbeat: 86400`, `threshold: 1` (%), `decimals: 8`, proxy `0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E`. |
| Observed publish interval | **86412–86436s** | The last six rounds read on-chain 2026-08-23 — the real cadence runs slightly *past* the nominal heartbeat. |
| `RELAY_MAX_SOURCE_AGE` default | 86400s | `script/DeployPriceRelay.s.sol`, both halves — the bare heartbeat, with no grace. The observed interval runs 86412-86436s, so the sender's `staleCheckLatestRoundData(i_maxSourceAge)` refuses to forward for the ~12-36s each day between the limit expiring and the next round landing. It is immutable on both contracts, so it is a deploy-time choice: pass **90000** (heartbeat + 1h grace). |
| Router window the **2-arg** `setPriceFeed` leaves | **3600s** | It resets `stalenessOf[token]` to 0, so `quote()` falls back to `OracleLib.TIMEOUT`. Any relayed answer older than an hour reverts `OracleLib__StalePrice()` — which, against a 24h source, is almost all of the time. |
| Router window the relay slot needs | **93600s** (26h) | The receiver admits a report up to `RELAY_MAX_SOURCE_AGE` (90000s) old at arrival, and the reported timestamp keeps ageing from the SOURCE round. 93600 leaves an hour of headroom past that admission cap. Set it with the **3-arg** `setPriceFeed`. |
| Relay cadence | one `relay` per source round; cron `*/5` | Monotonicity refuses a report whose `srcUpdatedAt` has not strictly advanced, so an early run costs one `eth_call` and reverts harmlessly. Firing promptly after each source round keeps the delivered age at minutes rather than hours. |

Two consequences worth stating outright:

1. **`setPriceFeed(token, feed, maxStaleness)` is mandatory for Path B**, not an option. The
   2-arg overload is correct for Path A — a keeper-refreshed `OperatorFeed` reports its own
   posting time on a 1800s heartbeat and wants the tight 3600s window — and it is wrong here,
   because the relay reports the SOURCE's timestamp on a 24h cadence. Same call, opposite
   answer, decided by which timestamp the feed publishes.
2. **A wider window is not a weaker guard here.** 93600s bounds a *relay outage*: the source
   stops, or the relay keeper stops, and within 26h the rail closes on its own. The thing a
   1-hour window would be protecting against — a fast-moving price going stale — is not the
   failure mode of a 24h-heartbeat stablecoin feed with a 1% deviation trigger.

**Path A needs no such change.** Its numbers already reconcile: 3600s router window, 1800s feed
heartbeat, 900s keeper threshold, `*/5` cron.

### The removal test

Delete both relay contracts and their tests:

- Arc keeps pricing, via Path A's `OperatorFeed`.
- `Access0x1Router` is byte-identical — it never imported either contract; the receiver
  occupied the existing `AggregatorV3Interface` slot.
- Every other chain is untouched; the ones with real Chainlink feeds (Base Sepolia, Ethereum
  Sepolia, Optimism Sepolia, Avalanche Fuji, Arbitrum Sepolia, ZKsync Sepolia) never involved
  a relay.
- Nothing else in `src/` or `script/` imports them, apart from their own deploy script.

What is lost is the Chainlink-backed claim for Arc, and nothing else. The seam is removable,
which is what makes recommending it honest.

---

## The owner command list

Every command below is for the **owner** to run. Nothing here has been broadcast; agents
prepare, the owner executes. Testnet only.

### Preconditions

```sh
# Arc gas is USDC. Confirm the deployer is funded before anything else.
cast balance $DEPLOYER --rpc-url $ARC_TESTNET_RPC_URL

# Confirm what the slot holds TODAY, and that it is indeed dead.
cast call $ROUTER "priceFeedOf(address)(address)" $ARC_USDC_ADDRESS --rpc-url $ARC_TESTNET_RPC_URL
cast call 0xdea2b9d695f92ffea246ff0a01bdcb1ff37d86b3 \
  "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $ARC_TESTNET_RPC_URL
```

### Path A — deploy, wire, and keep the operator feed fresh

```sh
# 1. Deploy the guarded feed. Defaults: 8 dp, $1.00, band 0.95..1.05, heartbeat 1800s,
#    owner = the broadcaster. Set ARC_OPERATOR_FEED_OPERATOR first to name the keeper's
#    hot key in the same broadcast.
forge script script/DeployArcOperatorFeed.s.sol:DeployArcOperatorFeed \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --account deployer --sender $DEPLOYER \
  --broadcast --verify --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api? \
  -vvvv

# 2. Record the printed address.
#    .env:  ARC_USDC_USD_FEED=<printed address>

# 3. Point the router at it. One owner call; no redeploy, no merchant re-registration.
cast send $ROUTER "setPriceFeed(address,address)" $ARC_USDC_ADDRESS $ARC_USDC_USD_FEED \
  --rpc-url $ARC_TESTNET_RPC_URL --account deployer

# 3b. The NATIVE slot points at the SAME dead mock (measured above), and Arc's native gas is
#     USDC-denominated, so it takes the same $1.00 feed. Skipping this leaves payNative dead.
cast send $ROUTER "setPriceFeed(address,address)" \
  0x0000000000000000000000000000000000000000 $ARC_USDC_USD_FEED \
  --rpc-url $ARC_TESTNET_RPC_URL --account deployer

# 4. CONFIRM before trusting it. Both quotes must return 1000000 ($1.00 against 6-dp USDC;
#    the native leg is 18-dp, so expect 1000000000000000000 there).
cast call $ROUTER "quote(uint256,address,uint256)(uint256)" 0 $ARC_USDC_ADDRESS 100000000 \
  --rpc-url $ARC_TESTNET_RPC_URL
cast call $ROUTER "quote(uint256,address,uint256)(uint256)" 0 \
  0x0000000000000000000000000000000000000000 100000000 --rpc-url $ARC_TESTNET_RPC_URL

# 5. Grant the keeper's hot key, when the deploy log's "operator grant" line says NOT set.
#    KEEPER_ADDRESS is the PUBLIC address of the `keeper` keystore, and .env must name it —
#    the make target refuses to run without it, because a wrong --sender signs with a wrong key:
#      cast wallet address --account keeper
cast send $ARC_USDC_USD_FEED "setOperator(address)" $KEEPER_ADDRESS \
  --rpc-url $ARC_TESTNET_RPC_URL --account deployer

# 6. Dry-run the keeper — read-only, no key, no broadcast. Run this first.
#    THE PRICE SOURCE IS NOT OPTIONAL. The keeper posts no default: unset both modes and a run
#    that finds the answer due REVERTS, on purpose (see "the attended case" above). This dry-run
#    is the cheapest place to discover that, with no hot key anywhere near it.
OPERATOR_FEED=$ARC_USDC_USD_FEED \
OPERATOR_FEED_SOURCE_RPC=$SEPOLIA_RPC_URL \
OPERATOR_FEED_SOURCE=0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E \
  forge script script/RefreshOperatorFeed.s.sol:RefreshOperatorFeed \
  --rpc-url $ARC_TESTNET_RPC_URL -vvv
# Expect the run to print `source desc : USDC / USD` and a `source age` under 90000. A different
# description means a different feed — stop and re-confirm the address before going further.

# 7. The keeper itself. Broadcast with the OPERATOR key, never the owner key.
OPERATOR_FEED=$ARC_USDC_USD_FEED \
OPERATOR_FEED_SOURCE_RPC=$SEPOLIA_RPC_URL \
OPERATOR_FEED_SOURCE=0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E \
  forge script script/RefreshOperatorFeed.s.sol:RefreshOperatorFeed \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --account keeper --sender $KEEPER_ADDRESS --broadcast -vvv
```

Cron entry (every 5 minutes). **`OPERATOR_FEED_SOURCE_RPC` + `OPERATOR_FEED_SOURCE` are what
make this cron honest** — a cron carrying `OPERATOR_FEED_ANSWER` instead is the constant-poster
failure, and a cron carrying neither reverts every time the answer comes due:

```cron
*/5 * * * * cd /path/to/Access0x1 && OPERATOR_FEED=0x... \
  OPERATOR_FEED_SOURCE_RPC="$SEPOLIA_RPC_URL" \
  OPERATOR_FEED_SOURCE=0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E \
  /usr/local/bin/forge script \
  script/RefreshOperatorFeed.s.sol:RefreshOperatorFeed --rpc-url "$ARC_TESTNET_RPC_URL" \
  --account keeper --sender "$KEEPER_ADDRESS" --broadcast >> /var/log/access0x1-feed.log 2>&1
```

**Monitor the log for the refusals, not just for failures.** Three lines mean the rail is about
to close and the cause is upstream, never in Arc: `source answer older than the configured
limit` (Sepolia's feed went dark), `source round incomplete`, and `answer outside the feed's
immutable band` (USDC genuinely left ±5%). Each one is the keeper declining to post, which
leaves the Arc answer ageing toward `OracleLib__StalePrice()` — correct, and worth an alert.

**Revoking the keeper**, the moment its key is suspected:

```sh
cast send $ARC_USDC_USD_FEED "setOperator(address)" 0x0000000000000000000000000000000000000000 \
  --rpc-url $ARC_TESTNET_RPC_URL --account deployer
```

Writes fall back to owner-only in the same block. The feed then ages out and the rail closes
within the router's window — which is the correct outcome while the compromise is
investigated.

### Path B — deploy and wire the CCIP relay

Order matters: the receiver first, because the sender needs its address.

```sh
# 1. DESTINATION (Arc). Confirm the Router address from docs.chain.link/ccip/directory first.
#    RELAY_MAX_SOURCE_AGE=90000 OVERRIDES the 86400 default on purpose: Sepolia USDC/USD's
#    published heartbeat is 86400s and its observed publish interval runs 86412-86436s, so the
#    bare heartbeat leaves no grace and refuses the source in that daily gap. It is IMMUTABLE on
#    both contracts, so this is a deploy-time decision. Both halves take the same number — a
#    receiver stricter than its sender rejects what the sender was willing to send.
RELAY_MAX_SOURCE_AGE=90000 \
RELAY_DEST_CCIP_ROUTER=0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8 \
  forge script script/DeployPriceRelay.s.sol:DeployPriceRelayReceiver \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --account deployer --sender $DEPLOYER \
  --broadcast --verify --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api? -vvvv

# 2. SOURCE (Ethereum Sepolia). CONFIRM both addresses from Chainlink's own docs:
#      RELAY_SRC_CCIP_ROUTER -> docs.chain.link/ccip/directory (Ethereum Sepolia Router)
#      RELAY_SOURCE_FEED     -> docs.chain.link/data-feeds/price-feeds/addresses (USDC/USD, Sepolia)
#    Never paste a feed address from memory — a wrong source feed is a wrong price for every
#    payment downstream. Confirmed 2026-08-23, both from Chainlink's reference data directory
#    and by reading the contract: 0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E answers
#    description() = "USDC / USD", decimals() = 8, version() = 4, heartbeat 86400s, 1% deviation.
RELAY_MAX_SOURCE_AGE=90000 \
RELAY_SRC_CCIP_ROUTER=<confirmed> \
RELAY_SOURCE_FEED=<confirmed> \
RELAY_DEST_SELECTOR=3034092155422581607 \
RELAY_DEST_RECEIVER=<the address from step 1> \
  forge script script/DeployPriceRelay.s.sol:DeployPriceRelaySender \
  --rpc-url $SEPOLIA_RPC_URL \
  --account deployer --sender $DEPLOYER --broadcast --verify -vvvv

# 3. Open the lane on the Arc receiver, naming the Sepolia sender.
#    16015286601757825753 is Ethereum Sepolia's CCIP chain selector — CONFIRM it.
cast send $RELAY_RECEIVER "setSourceLane(uint64,address)" 16015286601757825753 $RELAY_SENDER \
  --rpc-url $ARC_TESTNET_RPC_URL --account deployer

# 4. THE CONFIRMATION CALL — this is what settles the data-only-lane question. A Router that
#    quotes the message is a Router that accepts it. Read-only, costs nothing.
cast call $RELAY_SENDER "quoteFee(uint64,address)(uint256)" 3034092155422581607 \
  0x0000000000000000000000000000000000000000 --rpc-url $SEPOLIA_RPC_URL

# 5. Relay one price. Send the quoted fee plus slack; the excess is returned.
cast send $RELAY_SENDER "relay(uint64,bool)(bytes32)" 3034092155422581607 false \
  --value <quoted fee> --rpc-url $SEPOLIA_RPC_URL --account deployer

# 6. WAIT for CCIP delivery, then confirm a price actually landed on Arc.
cast call $RELAY_RECEIVER "latestRoundData()(uint80,int256,uint256,uint256,uint80)" \
  --rpc-url $ARC_TESTNET_RPC_URL

# 7. ONLY AFTER step 6 returns a real round, point the router at the receiver. Wiring it
#    empty would revert PriceRelayReceiver__NoPriceYet and close the rail on USDC.
#
#    USE THE 3-ARG OVERLOAD. The 2-arg setPriceFeed resets stalenessOf[token] to 0, which puts
#    quote() back on OracleLib.TIMEOUT = 3600s — and the receiver reports the SOURCE's
#    updatedAt on a 24h heartbeat, so a 1h window reverts StalePrice roughly 23 hours a day.
#    It fails CLOSED, so nothing mis-settles; the rail is simply shut. 93600s = the receiver's
#    90000s admission cap plus an hour. See the reconciliation table above.
cast send $ROUTER "setPriceFeed(address,address,uint256)" \
  $ARC_USDC_ADDRESS $RELAY_RECEIVER 93600 \
  --rpc-url $ARC_TESTNET_RPC_URL --account deployer

# 7b. CONFIRM the window landed, and that the quote is live through the relay.
cast call $ROUTER "stalenessOf(address)(uint256)" $ARC_USDC_ADDRESS \
  --rpc-url $ARC_TESTNET_RPC_URL           # expect 93600, never 0
cast call $ROUTER "quote(uint256,address,uint256)(uint256)" 0 $ARC_USDC_ADDRESS 100000000 \
  --rpc-url $ARC_TESTNET_RPC_URL
```

**Rolling back to Path A** is one call, at any time. The 2-arg overload is the right one here:
it resets `stalenessOf` to 0, and Path A's keeper-refreshed feed *wants* the tight 3600s
default. Rolling back with the 3-arg call would leave Path B's 26h window over a feed that
re-posts every 30 minutes — a 26-hour-stale `OperatorFeed` answer would then settle payments.

```sh
cast send $ROUTER "setPriceFeed(address,address)" $ARC_USDC_ADDRESS $ARC_USDC_USD_FEED \
  --rpc-url $ARC_TESTNET_RPC_URL --account deployer
cast call $ROUTER "stalenessOf(address)(uint256)" $ARC_USDC_ADDRESS \
  --rpc-url $ARC_TESTNET_RPC_URL           # expect 0 (⇒ the 3600s default), never 93600
```

The relay needs its own keeper — anyone may call `relay`, permissionlessly, because the value
comes from an immutable aggregator read inside the call. A caller chooses the moment of a
refresh and never the number, so a stalled keeper cannot hold Arc hostage.

---

## What was ruled out, and why

| Option | Verdict on Arc |
|---|---|
| Chainlink **Data Feeds** | **No.** Zero entries for Arc or 5042002 in Chainlink's own address registry (2026-08-23). |
| Chainlink **Data Streams** | **No.** Zero entries in the supported-networks list; no `VerifierProxy` exists on Arc, so there is no on-chain verification path at all. |
| Chainlink **CCIP** relay | **Yes** — live Router, live selector, live bidirectional lane to Ethereum Sepolia. Path B. |
| Chainlink **CRE** | Arc Testnet is an officially supported CRE network (CLI v1.0.7+, TS SDK v1.3.1+), but **deploying a workflow requires Chainlink's approval**, and this account's `cre whoami` reports "Deploy Access: Not enabled". A scheduled CRE price push therefore caps out at *designed and simulated*, the same ceiling the shipped [`cre/workflow.ts`](../cre/workflow.ts) already sits under. Not built here; recorded as the option it is. |

---

## See also

- [PRICE-SOURCES.md](./PRICE-SOURCES.md) — the swappable oracle seam and its conformance contract.
- [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md) — the source of truth for every live address.
- [ARC-DEPLOY.md](./ARC-DEPLOY.md) — deploying the rest of the stack on Arc.
- [`src/libraries/OracleLib.sol`](../src/libraries/OracleLib.sol) — the staleness guard both paths rely on.
