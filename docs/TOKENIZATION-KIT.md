<!--
  TOKENIZATION-KIT — the sector-preset token layer for Access0x1.

  Documents the cloneable ERC-721/ERC-1155 token presets in src/tokens/ that sit
  ALONGSIDE the money spine (Access0x1Router + the escrow/subscription/invoice
  ledgers). These are the TOKEN ARTIFACTS a commerce flow mints — the reservation
  NFT, the ticket, the receipt, the membership, the invoice, the deed — each
  vanilla Solidity, MIT, testnet-first, and param-first (nothing hardcoded).

  Addresses are NOT restated by hand — the shared router is quoted from the
  canonical homes (README "Deployments" + docs/CHAIN-ADDRESSES.md). Presets are
  brand-neutral by design (a preset serves "reservations" / "ticketing" /
  "creator platforms", never a specific app). New file — modifies no other docs.
-->

# Tokenization Kit — tokenize anything on the shared rail

Access0x1 ships two layers that compose cleanly:

- **The money spine** — the shared, multi-tenant, zero-custody `Access0x1Router` (prices
  USD→token via a Chainlink feed *inside* the pay tx, splits an exact fee, pushes
  net→merchant + fee→treasury) plus its self-audited escrow / subscription / invoice ledgers.
- **The tokenization kit** (this doc) — cloneable **token artifacts** the commerce flow mints:
  a reservation NFT, an event ticket, a purchase receipt, a membership, an invoice, a deed.
  Each is its own independently-deployable contract, **vanilla Solidity, MIT, param-first**
  (treasury / fees / royalties / roles / compliance are ALWAYS constructor or admin params —
  never hardcoded), and either holds no funds at all or composes the router for the money leg.

**Clone it, set your params, deploy.** Every preset takes its authority set and economics as
parameters, so the base stays usable exactly as we use it *and* configurable so anyone clones it
and runs it their way. Testnets only (mainnet is owner-gated, post-audit).

## Who this is for — and what actually works today

Two audiences ask for this kit. Both get an honest answer here, because the difference between
"the contracts exist" and "the flow works end to end" is exactly where a tokenization pitch
usually stops being true.

**Nothing in this kit is deployed on any chain.** None of these contracts is in
`script/DeployAll.s.sol`, so no `broadcast/` record carries them and **no address is claimed for
any of them** (law #3). `HouseTokenFactory` is the one asset-adjacent contract that IS deployed,
and it is a plain loyalty/store-credit ERC-20 factory, not an RWA contract. You deploy the kit
yourself, wire the roles yourself, and it costs you a `forge script` — that is the whole model.

### 1. A business that wants to sell an asset to people

**This works today, and it is composed, not built-in.** The deed is a token; the sale is the
same USD-priced router settlement every other payment uses. `Access0x1Nft` is a generic,
zero-custody, USD-priced ERC-721 marketplace, and it accepts **any** collection — including a
uRWA-compliant one.

```
1.  deploy DeedToken(name, symbol, admin)          # not in DeployAll — deploy it yourself
2.  grantRole(MINTER_ROLE, issuer); grantRole(WHITELIST_ROLE, compliance)
3.  setWhitelisted(seller, true)
    setWhitelisted(buyer,  true)
    setWhitelisted(address(access0x1Nft), true)    # ← the trap. see below.
4.  mintDeed(seller, tokenId, registryRef, uri)
5.  router.registerMerchant(payout, feeRecipient, feeBps, nameHash)
6.  deedToken.approve(address(access0x1Nft), tokenId)
7.  access0x1Nft.list(merchantId, address(deedToken), tokenId, USDC, priceUsd8)
8.  access0x1Nft.buy(listingId, maxPriceUsd8, maxTokenAmount)
```

> **The trap in step 3.** `Access0x1Nft` escrows the token while it is listed, so the
> **marketplace contract itself** must pass `canReceive`. Miss it and step 7 reverts
> `ERC7943CannotReceive` — on the escrow leg, which reads like the seller is non-compliant. This
> is the single thing that will cost you an afternoon.
>
> A second-order note: in `buy`, the router settlement happens **before** the token is
> delivered. A non-whitelisted buyer therefore reverts the whole transaction — no money is
> lost, the payment rolls back with it — but there is no friendly pre-flight check, so the buyer
> sees a raw revert rather than "you are not cleared to hold this asset."

**Honest gaps in this flow:** no deploy script, no SDK/ABI (`DeedToken` is not in
`web/lib/generated/module-abis.ts`), no UI, and no test yet combines a uRWA token with
`Access0x1Nft` — the marketplace suite uses a plain `MockERC721`. The composition is sound and
each half is tested; the seam between them is not.

**Compliance here is an allowlist, not KYC.** `canSend`/`canReceive` read a `WHITELIST_ROLE`
map. `CredentialSbt` can issue and validate a real credential — but **nothing in the repo reads
it**, so a credential-gated asset needs a ~20-line subclass overriding `canSend`/`canReceive` to
call `hasValidCredential`. The override pattern is proven in
`test/unit/Access0x1RwaToken.t.sol` against a mock registry; the `CredentialSbt`-backed version
does not exist yet.

### 2. Taking money for property — deposits, rent, invoices

**This is the part that needs no new code at all**, and it is deployed on eleven testnets today:

- **`Access0x1Bookings`** — a USD-priced, refundable holding deposit whose cancellation
  policy is snapshotted at reserve and never mutated, so a merchant cannot withhold a refund
  that policy owes, nor raise the fee after the fact. The policy is still the merchant's, and
  it may define a window in which no refund is owed at all.
- **`Access0x1Subscriptions`** — recurring USD rent with dunning, renewed by a permissionless
  keeper.
- **`Access0x1Invoices`** — a one-shot USD invoice, settled through the same fee split.
- **`SplitSettler`** — fan one settled USD payment out to N payees by basis points.

None of these touch the RWA tokens. They settle against a merchant id, which is why they work
now: the money path never needed the asset layer.

### 3. An AI agent acting on an owner's behalf

Be precise here, because there are **two separate budget systems and they are not connected**:

- **On-chain `SessionGrant`** — a real, revocable, budget-capped spend mandate. But
  `sessionGrant.spend` has exactly **one caller in the entire codebase**
  (`Access0x1Subscriptions`). An on-chain mandate can renew a subscription. It **cannot** buy an
  NFT, mint a deed, or deposit into a vault.
- **The off-chain agent meter** (`web/lib/agent/**`) — a durable daily USD cap over x402 /
  EIP-3009 micro-payments. It pays a **URL**, not a contract. It never touches `SessionGrant`.

**So what an agent can genuinely do today:** pay for inference, data, or a valuation feed under a
daily cap; sign a human up for recurring payments that then renew autonomously under an on-chain,
revocable, budget-capped mandate; cancel a booking under a two-gate consent check. That is a real
"agent with a mandate" story — and it is a **rent and subscription** story, not an
asset-purchase one.

**What an agent cannot do today, stated plainly:** buy a tokenized asset under a spend mandate.
The missing piece is one function — a `buyWithSession` on `Access0x1Nft` that calls
`sessionGrant.spend` before `router.payToken`, exactly as `Access0x1Subscriptions` already does.
Until that exists, an "AI agent buys property" claim would be an overclaim, and this page will
not make it.

## The map — sector → contract → use case

| Sector | Contract | Standard | Composes the router? | Use case |
| --- | --- | --- | --- | --- |
| Compliant RWA base | [`Access0x1RwaToken`](../src/Access0x1RwaToken.sol) | ERC-721 + ERC-7943 (uRWA) | no | The compliant-asset base: per-token freeze, authorized `forcedTransfer` (seizure / recovery), `canSend`/`canReceive` policy gates. Everything below that needs compliance inherits it. |
| Verified credentials | [`CredentialSbt`](../src/CredentialSbt.sol) | ERC-721 + ERC-5192 (soulbound) + EIP-712 vouchers | no | A soulbound, level-bearing **verified-credential badge**: one contract serves many credential kinds via a `bytes32 credType`; optional expiry, issuer revoke + subject renounce, gasless claim accepting EOA / ERC-1271 / ERC-6492 issuers. Full section below. |
| Reservations | [`BookingToken`](../src/tokens/BookingToken.sol) | ERC-721 | **yes** (release leg) | A time-slot reservation as a **transferable NFT with an attached, refundable USD deposit**. Confirm releases through the fee-split; cancel/expire refund the holder. The merchant can **never** block a refund. |
| Ticketing | [`TicketToken`](../src/tokens/TicketToken.sol) | ERC-721 + ERC-2981 | no (sale settles via router) | Event tickets with seat/tier metadata, a resale **transfer window** (non-transferable + freeze cutoff), one-way **check-in** (flag or burn), and a param'd royalty. |
| Commerce receipts + loyalty | [`ReceiptToken`](../src/tokens/ReceiptToken.sol) | ERC-1155 | no (sale settles via router) | Per-order **proof-of-purchase** receipts (soulbound-optional) + a fungible **loyalty-point** balance that accrues on settlement and redeems by burning (one-shot per redemption id). |
| Creator platforms / subscriptions | [`MembershipToken`](../src/tokens/MembershipToken.sol) | ERC-1155 | declares the split | Tiered memberships with **time-boxed validity** (renew extends, lapse restarts), soulbound-optional tiers, and a param'd platform-fee split (`quoteSplit` mirrors the router's floor-bps math to the wei). |
| Invoicing / B2B | [`InvoiceToken`](../src/tokens/InvoiceToken.sol) | ERC-721 | **yes** (settlement leg) | A USD invoice as an NFT settled **once, gaslessly** off a single EIP-3009 authorization any relayer submits — bound to the exact merchant/amount/invoice by a structured nonce, so a relayer can't redirect it. Routes through the fee-split. |
| RWA deeds / titles | [`DeedToken`](../src/tokens/DeedToken.sol) | ERC-721 + ERC-7943 (uRWA) | no | A titled asset on the uRWA base (inherits all compliance) with deed metadata + an optional, param'd **fractionalization hook** (an external ERC-20 wrapper factory the clone chooses). |
| Fractional shares | [`RwaShareVault`](../src/RwaShareVault.sol) | ERC-4626 | no | A share vault over any ERC-20 asset: deposit mints shares, redeem returns the underlying pro-rata. Pause is **deposit-side only** — `_withdraw` is deliberately not overridden, so redemption can never be blocked. **Read the honest limits below before using it for an RWA:** the shares are an ungated ERC-20 (no compliance, no allowlist), there is no USD pricing, and there is no income-distribution mechanism. |

## Deploy params — what each preset takes

Every preset's authority + economics are constructor / admin params. **No address, fee, or feed
is baked in.** The shared router is the same on every mirrored testnet
(`0xe92244e3368561faf21648146511DeDE3a475EB5` — see the README "Deployments" table and
[`CHAIN-ADDRESSES.md`](./CHAIN-ADDRESSES.md); do not hand-copy it into code).

| Contract | Constructor params | Post-deploy admin knobs |
| --- | --- | --- |
| `Access0x1RwaToken` | `name`, `symbol`, `admin` | admin grants `MINTER`/`BURNER`/`FREEZER`/`WHITELIST`/`FORCE_TRANSFER` roles; manages the reference allowlist (or overrides `canSend`/`canReceive` with real KYC) |
| `CredentialSbt` | `name`, `symbol`, `admin` | admin grants `ISSUER_ROLE` — issue / `setLevel` / revoke plus the voucher-signing authority (ERC-1271 smart-account issuers welcome) |
| `BookingToken` | `name`, `symbol`, `router` | none (immutable, non-custodial) — bookings bind to a router `merchantId`; only that merchant's router owner confirms |
| `TicketToken` | `name`, `symbol`, `admin`, `royaltyReceiver`, `royaltyBps` (≤ 1000) | admin grants `MINTER`/`CHECKIN` roles, sets default/per-token royalty; check-in role sets per-ticket transfer policy |
| `ReceiptToken` | `baseUri`, `admin`, `pointsSoulbound` | admin grants `ISSUER` role |
| `MembershipToken` | `baseUri`, `admin`, `platformFeeBps` (≤ 1000), `platformTreasury` | admin grants `MINTER`/`MANAGER` roles, sets tiers (price / period / soulbound / uri) + the declared platform fee |
| `InvoiceToken` | `name`, `symbol`, `router` | none (immutable, non-custodial) — invoices bind to a router `merchantId`; only that merchant's router owner issues/voids |
| `DeedToken` | `name`, `symbol`, `admin` | admin grants the uRWA roles (as the RWA base) + sets the optional `fractionalizer` |

### Decisions left param'd for cloners

- **Fee / royalty rates** — every rate is a bps param bounded by a `MAX_*_BPS` ceiling (10%, matching
  the router). A no-fee / no-royalty product passes `0`.
- **Who mints / who checks in / who freezes** — all role grants, never wired to a fixed address.
- **Compliance mechanism** — the uRWA base ships an allowlist reference; a clone with a real
  identity registry overrides `canSend`/`canReceive` and inherits enforcement unchanged.
- **Fractionalization** — `DeedToken` takes an *external* wrapper factory address; the wrapper's
  economics are entirely the clone's (or disabled with `address(0)`).
- **Soulbound vs tradeable** — receipts and membership tiers are soulbound-optional per token/tier;
  loyalty points are poolable by default, non-transferable if a clone flips one constructor flag.
- **Burn-on-entry vs keep-as-collectible** — `TicketToken.checkIn(burn)` is a per-call choice.

## Quickstart — the "set your params" flow

The kit follows the repo's prewired-clone story: clone, set your params, deploy one contract.

```solidity
// 1. Event ticketing — tickets with a 5% resale royalty to your treasury.
TicketToken tickets = new TicketToken(
    "Summer Series Passes", "PASS",
    msg.sender,          // admin (grants MINTER to your sale backend, CHECKIN to the gate app)
    yourRoyaltyWallet,   // ERC-2981 royalty receiver
    500                  // 5% resale royalty (bps; <= 1000)
);
tickets.grantRole(tickets.MINTER_ROLE(), yourSaleBackend);
tickets.grantRole(tickets.CHECKIN_ROLE(), yourGateApp);
// On a router-settled sale, MINTER mints the ticket with seat/tier + a transfer window.

// 2. Reservations — a resellable slot NFT with a refundable, router-priced deposit.
BookingToken bookings = new BookingToken(
    "Studio Slots", "SLOT",
    routerAddress        // the shared Access0x1Router on your settlement chain
);
// A buyer books: mintBooking(...) pulls a USD-priced deposit into escrow and mints the slot NFT.
// The merchant owner confirms (release through the fee-split); the holder cancels or expires
// (full refund — the merchant can NEVER block it).

// 3. Invoicing — a gasless, merchant-bound invoice.
InvoiceToken invoices = new InvoiceToken("Studio Invoices", "INV", routerAddress);
// The merchant owner issues an invoice NFT for a USD amount; the debtor settles it with ONE
// EIP-3009 signature any relayer submits, bound to this exact invoice by settlementNonce(...).
```

## `CredentialSbt` — the verified-credential badge

A soulbound ERC-721 that an **issuer** grants to a **subject** as an on-chain, level-bearing,
optionally-expiring attestation. It is the generic primitive behind a "verified-credential badge" — the
`credType` key makes it domain-agnostic, so one deployment can attest business-verification,
KYC-attestation, membership tiers, or anything else without a new contract.

### Model

- **One contract, many credential kinds.** A badge is issued under a `credType` (`bytes32`, e.g.
  `keccak256("business-verified")`). Exactly **one active badge per `(subject, credType)`** — a second
  issue for a live pair reverts `CredentialSbt__AlreadyIssued`; the slot frees on burn so a fresh badge
  can be issued later.
- **Levels.** Every badge carries a `uint8 level` (non-zero; `0` is the "no badge" sentinel). The issuer
  can **raise or lower** it via `setLevel`, emitting `LevelChanged`.
- **Soulbound (ERC-5192).** `locked(tokenId)` is always `true` for an existing badge, `Locked` is emitted
  at mint (never `Unlocked`), and ERC-165 advertises the ERC-5192 id `0xb45a3c0e`. Every transfer path
  (`transferFrom`, `safeTransferFrom`, approved-operator) hard-reverts `CredentialSbt__Soulbound`, and so
  do `approve` / `setApprovalForAll` — an approval can only ever enable a (forbidden) transfer.
- **Expiry.** An optional `expiresAt` (unix seconds; `0` = never). `isValid(tokenId)` and
  `hasValidCredential(subject, credType)` return true only while the badge exists, is not revoked, and is
  not past expiry. Expiry does **not** burn the token — it flips validity, and the badge can be re-leveled
  or revoked as usual.

### Issuance

Two paths, both mint the same soulbound badge:

1. **Direct** — `issue(subject, credType, level, expiresAt)`, callable by any holder of `ISSUER_ROLE`.
2. **Gasless voucher** — the issuer signs an **EIP-712** `Credential` struct offline; anyone (typically
   the subject, but any relayer) submits it via
   `claim(issuer, subject, credType, level, expiresAt, nonce, deadline, signature)`. The signature is
   validated against `issuer` accepting **EOA, ERC-1271** (deployed smart account), and **ERC-6492**
   (counterfactual / not-yet-deployed smart account) — the same predeploy-aware validator `SessionGrant`
   uses. The recovered signer must hold `ISSUER_ROLE`; the badge always lands on the **voucher's**
   `subject`, so a relayer cannot redirect it. Replay is guarded by a **per-issuer nonce** (a claimed
   `(issuer, nonce)` can never mint twice), and vouchers carry a `deadline`.

### Revocation

- **Issuer revoke** — `revoke(tokenId)` (holder of `ISSUER_ROLE`) burns the badge and frees the pair.
- **Subject renounce** — `renounce(tokenId)` lets the subject burn **their own** badge; a person can always
  renounce a credential, independent of the issuer.

Burn semantics follow ERC-5484: both the issuer and the subject may burn (a fixed policy for a credential
primitive, chosen over a per-token `BurnAuth` enum to keep the surface lean).

### Custody

**None.** `CredentialSbt` is a pure attestation registry — no value transfer, no `payable` function. The
only external interaction is signature validation on the `claim` path (the ERC-6492 factory `prepare`
call), which precedes every state change (checks-effects-interactions); the voucher nonce is marked used
before the mint, so a re-entrant claim on the same voucher reverts.

## Security posture (what the kit guarantees)

- **Money paths roll back, never swallow.** The router legs are wrapped so an oracle outage or a
  de-allowlisted token can never brick a refund. A `BookingToken` refund the policy owes
  **cannot be withheld** by the merchant; a failed push queues to a claimable pull-map
  (length-safe, USDT-style-token-safe).
- **Merchant-binding.** `InvoiceToken` reuses the `GaslessPayIn` structured-nonce design so a relayer
  holding a signed authorization **cannot** redirect settlement to another merchant/amount/invoice.
- **Single-settlement.** Invoices are an absorbing `OPEN→PAID` machine; receipt/redemption ids are
  one-shot; bookings resolve through exactly one terminal transition — all backed by tests.
- **Zero custody.** Presets that touch money hold ~zero token after each call (escrow-ledger
  conservation for `BookingToken`; a zero-residual delta check for `InvoiceToken`). The pure-artifact
  presets (ticket / receipt / membership / deed) hold no funds at all.
- **Compliance is single-sourced.** `DeedToken` inherits the entire ERC-7943 (uRWA) surface from
  `Access0x1RwaToken` — it re-implements no compliance logic, so there is one place to audit.

## Tests

Every preset has a dedicated suite: happy paths, revert paths, access control, fee/royalty
rounding (fuzzed), the refund-never-blocked invariant, escrow conservation (fuzzed), and — for
`InvoiceToken` — explicit relayer-redirect red-team cases.

They do **not** all live in one directory, and the command this page used to give
(`--match-path 'test/unit/tokens/*'`) silently skipped three of them — the uRWA base, the
credential, and the vault, which sit in `test/unit/`. Run the kit with both paths:

```sh
forge test --match-path 'test/unit/tokens/*'
forge test --match-path 'test/unit/{Access0x1RwaToken,CredentialSbt,RwaShareVault}.t.sol'
```

`make test` runs the whole tree and is the honest single command.

The attestation primitives keep their own suites at the repo root:
[`test/unit/CredentialSbt.t.sol`](../test/unit/CredentialSbt.t.sol) — the full lifecycle (direct issue,
gasless claim with EOA / ERC-1271 / ERC-6492 issuers, level raise/lower, revoke + renounce, expiry
validity flips, the one-active-badge-per-pair invariant, every soulbound transfer + approval revert,
signature negatives incl. replayed nonce + malformed 6492 wrapper, and fuzz) — and
[`test/unit/Access0x1RwaToken.t.sol`](../test/unit/Access0x1RwaToken.t.sol) — the ERC-7943 surface and
its `_update` enforcement.
