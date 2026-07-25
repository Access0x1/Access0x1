# Pricing — currencies, and why regional pricing is only half-buildable

Two requests arrive together and they have different answers. One is genuinely web3-native
and is now built. The other cannot be, and this page says so rather than shipping something
that only looks like it.

---

## 1. EUR pricing — BUILT, and web3-native

**Why it qualifies.** The router prices in USD with 8 decimals and converts USD→token via
that token's Chainlink feed *inside* the settlement transaction. A euro price needs exactly
one more step of the same kind: read EUR/USD from a Chainlink aggregator on-chain and
convert. The rate is a value anyone can verify at the same block, not a number this app
looked up and asked you to trust.

A server-side FX API would have been faster to write and would have been the wrong thing —
the buyer could not check it, the contract never saw it, and "the price was right, trust
us" is the exact shape of claim this project refuses to make.

**Where it lives.** `web/lib/pricing/fx.ts`.

- `eurUsdRate8(client, chainId, now)` — reads the feed, returns the rate at 8 decimals.
- `eurToUsd8(eurAmount8, rate8)` — converts, rounding **up** so a truncation never
  short-changes the merchant (the same direction `quote()` rounds, for the same reason).

**The refusals are the feature.** It returns `null` — and the UI shows USD only — when the
feed is unconfigured, the answer is non-positive, the round never completed, the answer is
older than one hour, or the RPC fails. That staleness window is deliberately the same
number `OracleLib` enforces on the money path, so a rate the display trusts and a rate the
contract would trust cannot diverge. **A wrong FX rate is a wrong charge; a missing euro
price is a missing feature.** Those are not comparable costs.

**To switch it on** set the aggregator per chain — never hardcoded (law #3):

```
NEXT_PUBLIC_EUR_USD_FEED_<chainId>=0x...
```

Settlement is unchanged: the router still re-prices USD→token in-transaction, so every
existing guarantee holds. EUR is a pricing *denomination*, not a new settlement path.

---

## 2. Purchasing-power / regional pricing — NOT built, and here is the honest reason

The ask is real and the economics are right: $29 means something very different in Lisbon
than in Zurich, and hotel pricing has worked this way forever. The problem is not whether
it *should* exist. It is that **the thing you would key it on does not exist on-chain.**

To charge by region you must first know the buyer's region. Every available way to learn it
fails a different way:

| How you could determine it | Why it is not web3-native |
| --- | --- |
| **Geo-IP** | A server reads the request IP. Off-chain, unverifiable by the buyer, defeated by any VPN, and it makes the app hold location data it currently never touches. |
| **Buyer selects their country** | Nothing stops anyone selecting the cheapest. It is not a price tier, it is a discount code with extra steps. |
| **A credential proving residence** | This would work — and **no such credential exists here.** World ID proves *personhood*, deliberately not location. `CredentialSbt` can carry an arbitrary `credType`, but nothing issues a residency claim and, as of today, **nothing in the repo reads `hasValidCredential` at all.** |

So a regional-pricing feature built today would be geo-IP with on-chain settlement bolted
on. The settlement would be verifiable and the *thing that set the price* would not be —
which is precisely the seam an adversarial reviewer goes looking for. **Per your own
instruction: scrapped rather than faked.**

### The version that WOULD be web3-native, when there is a credential to read

Worth writing down, because it is a genuinely better design than the industry norm and the
pieces are three-quarters present:

1. The merchant publishes a **tier set** — top tier plus named lower tiers.
2. A buyer presents a **credential** proving eligibility for a lower tier.
3. `canReceive`-style logic checks it and prices that tier; **no credential ⇒ top tier.**

Two properties fall out of that ordering. It is **fail-closed** — the default is full
price, so a failure costs the buyer a discount rather than costing the merchant revenue.
And it is **harder to game than Steam or Netflix regional pricing**, which are VPN-defeated
daily, because it requires a proof rather than an IP address.

What is missing is exactly one thing: an issuer for a residency credential, and a subclass
that reads it. The override pattern is already proven in
`test/unit/Access0x1RwaToken.t.sol`, which gates transfers on a mock identity registry —
against a mock, because the real issuer does not exist yet either.

**Until that credential exists, this stays a design, not a claim.**

---

## The rule underneath both answers

A price is the most checkable thing a payment product asserts. If a number cannot be traced
to something the buyer can verify — a Chainlink round, an on-chain tier, a proof they
presented — then it is a number we made up, and no amount of on-chain settlement underneath
makes it otherwise.

EUR passes that test today. Region does not, yet.
