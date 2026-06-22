# Glossary — Access0x1 in plain English

Coming from web2? Every term below maps an Access0x1 concept to something you
already know, then points at where it lives in the code. Read it alongside
[ARCHITECTURE.md](./ARCHITECTURE.md).

### Router (`Access0x1Router`)
The one shared, multi-tenant contract every merchant integrates with — think of
it as a **payment processor's API endpoint**, except it's on-chain and you don't
deploy it. A payment is a single call to it.
→ [`src/Access0x1Router.sol`](../src/Access0x1Router.sol)

### Merchant / `merchantId`
A registered seller. When a business registers it gets a numeric `merchantId`
(like a **Stripe account id**) that buyers reference when they pay. The merchant
record holds the payout address and the optional surcharge.
→ [`registerMerchant`](../src/Access0x1Router.sol#L299)

### Quote / USD-priced-in-transaction
You charge a **human dollar amount** (`$29.00`); the router converts it to the
exact token amount at pay time. The conversion happens **inside the same
transaction** as the payment, so there's no off-chain price to trust — the price
and the charge are atomic.
→ [`quote()`](../src/Access0x1Router.sol#L524)

### Chainlink price feed
The on-chain **exchange-rate oracle** the router reads to do that USD→token
conversion. It's the source of truth for "how much ETH/USDC is $29 right now."
→ used inside [`quote()`](../src/Access0x1Router.sol#L524); addresses per chain in [CHAIN-ADDRESSES.md](./CHAIN-ADDRESSES.md)

### Oracle staleness guard
A safety check that **rejects a stale price**. If the feed hasn't updated within
the timeout (1 hour) or the round never completed, settlement reverts rather than
trusting an old number.
→ [`src/libraries/OracleLib.sol`](../src/libraries/OracleLib.sol) (`TIMEOUT = 3600`)

### Gross / net / fee
The three parts of every payment. **Gross** = what the buyer pays. **Fee** = the
platform + merchant cut. **Net** = what the merchant receives. They always
balance exactly: `net + fee == gross`.
→ [fee-split math](../src/Access0x1Router.sol#L592)

### Basis points (bps) · `MAX_FEE_BPS`
Fees are measured in **basis points**: 1 bp = 0.01%, so 100 bps = 1%. The total
fee (platform + merchant surcharge) is capped at `MAX_FEE_BPS = 1000` (**10%**),
so the platform can never set a confiscatory fee.
→ [`MAX_FEE_BPS`](../src/Access0x1Router.sol#L81)

### Zero custody
The router is a **pass-through, not a wallet** — its balance is ≈ 0 after every
payment. Money flows buyer → merchant + treasury in the same block; nothing sits
in the contract to be withdrawn or stolen.
→ [ARCHITECTURE.md §1.4](./ARCHITECTURE.md)

### Native vs ERC-20 payment
**Native** = paying in the chain's built-in coin (ETH on Ethereum, USDC on Arc).
**ERC-20** = paying in a token contract (e.g. USDC on Base). Two entry points,
same fee math.
→ [`payNative`](../src/Access0x1Router.sol#L665) · [`payToken`](../src/Access0x1Router.sol#L718)

### Token allowlist
The set of ERC-20s a merchant will accept. Only allowlisted tokens can be used
in `payToken` — an admin adds/removes them, so a buyer can't pay in some junk
token.
→ [`TokenAllowedSet`](../src/Access0x1Router.sol#L180)

### Fee-on-transfer token
A "deflationary" token that **secretly skims** a cut on every transfer. The router
**rejects** these by measuring the actual amount received and reverting if it
doesn't match — otherwise the fee math would silently desync.
→ [the `received != amount` guard](../src/Access0x1Router.sol#L650)

### SessionGrant
A pre-authorized **spend budget**. A buyer approves an amount once, and recurring
or metered products (subscriptions, bookings) draw against it without prompting
the wallet every time — and it can never go negative.
→ [`src/SessionGrant.sol`](../src/SessionGrant.sol)

### PaymentLanes (ERC-6909)
ERC-6909 is a **multi-token standard** (one contract, many token ids).
PaymentLanes uses it to track per-asset balances with conservation invariants —
the foundation for the cross-chain stretch.
→ [`src/PaymentLanes.sol`](../src/PaymentLanes.sol)

### UUPS proxy / implementation / freeze
The contracts are **upgradeable**. The **proxy** is the permanent address users
interact with; the **implementation** holds the logic and can be swapped by the
owner — **until** they call `renounceOwnership()`, which freezes the code
forever. (Practical rule for contributors: never reorder existing storage.)
→ [STORAGE-LAYOUT.md](./STORAGE-LAYOUT.md) · [ARCHITECTURE.md → Upgradeability](./ARCHITECTURE.md)

### Ownable2Step
A **fat-finger-safe admin transfer**: handing over ownership takes two steps (the
new owner must accept), so a mistyped address can't brick admin control.
→ used by [`Access0x1Router`](../src/Access0x1Router.sol#L48)

### SIWE (Sign-In-with-Ethereum)
Logging in by **signing a message with your wallet** instead of a username +
password. No server, no cookie — the wallet is the session. (Used by the
[example](https://github.com/Access0x1/Access0x1) frontend.)

---

Term missing? Open an issue on
[github.com/Access0x1/Access0x1](https://github.com/Access0x1/Access0x1).
