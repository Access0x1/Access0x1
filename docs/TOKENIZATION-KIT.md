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
  net→merchant + fee→treasury) plus its audited escrow / subscription / invoice ledgers.
- **The tokenization kit** (this doc) — cloneable **token artifacts** the commerce flow mints:
  a reservation NFT, an event ticket, a purchase receipt, a membership, an invoice, a deed.
  Each is its own independently-deployable contract, **vanilla Solidity, MIT, param-first**
  (treasury / fees / royalties / roles / compliance are ALWAYS constructor or admin params —
  never hardcoded), and either holds no funds at all or composes the router for the money leg.

**Clone it, set your params, deploy.** Every preset takes its authority set and economics as
parameters, so the base stays usable exactly as we use it *and* configurable so anyone clones it
and runs it their way. Testnets only (mainnet is owner-gated, post-audit).

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
  de-allowlisted token can never brick a refund. `BookingToken` refunds are **never blockable** by
  the merchant; a failed push queues to a claimable pull-map (length-safe, USDT-style-token-safe).
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

Every preset has a dedicated suite under [`test/unit/tokens/`](../test/unit/tokens/): happy paths,
revert paths, access control, fee/royalty rounding (fuzzed), the refund-never-blocked invariant,
escrow conservation (fuzzed), and — for `InvoiceToken` — explicit relayer-redirect red-team cases.
Run them with `forge test --match-path 'test/unit/tokens/*'`.

The attestation primitives keep their own suites at the repo root:
[`test/unit/CredentialSbt.t.sol`](../test/unit/CredentialSbt.t.sol) — the full lifecycle (direct issue,
gasless claim with EOA / ERC-1271 / ERC-6492 issuers, level raise/lower, revoke + renounce, expiry
validity flips, the one-active-badge-per-pair invariant, every soulbound transfer + approval revert,
signature negatives incl. replayed nonce + malformed 6492 wrapper, and fuzz) — and
[`test/unit/Access0x1RwaToken.t.sol`](../test/unit/Access0x1RwaToken.t.sol) — the ERC-7943 surface and
its `_update` enforcement.
