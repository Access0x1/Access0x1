# Access0x1 — Smart-Contract Security Audit Report

| | |
| --- | --- |
| **Protocol** | Access0x1 — open, multi-chain, zero-custody payments + session-auth layer |
| **Scope** | The first-party Solidity in `src/`: **20 contracts + 2 libraries (`NameMath`, `OracleLib`) + 16 interfaces** (22 `.sol` in `src/` excluding interfaces). The per-instance static-tool findings (§6) and the deep money-path review (§3, §5, §7) center the money spine + the long-standing commerce set; the newer additions (`SplitSettler`, `Access0x1Escrow`, `Receivables`, `Refunds`, `GaslessPayIn`, `PriceOracleAdapter`, `AutomationGateway`, `Access0x1ProvenanceRegistry`, `Access0x1Nft`) are built, tested, and compose the same audited spine — they are reviewed here against the same money laws before any mainnet claim. |
| **Commit** | The merged `main` spine + the commerce set + the fuzz/symbolic/integration tiers. |
| **Toolchain** | Foundry (forge 1.3.5 / solc 0.8.28, EVM `cancun`, `via_ir`), Aderyn v0.1.9, Slither v0.11.5, Halmos (symbolic). |
| **Methodology** | Foundry unit + invariant + adversarial (`test/attack/**`) + integration + fuzz + scenario suites, Halmos symbolic proofs (`test/symbolic/**`), Aderyn, Slither, `forge coverage`, manual review |
| **Status at event** | **Testnet-only.** The CREATE3 mirror is live on eight testnets (Arc / Base / Optimism / Arbitrum / Celo / Avalanche / Robinhood + Ethereum Sepolia), source-verified on seven. Mainnet deployment is gated on an independent third-party audit (see §8). |
| **Report style** | Cyfrin-style: scope → methodology → posture → findings (resolve-or-justify) → residual risk |

> This report records the security work performed during the build. It is an
> internal engineering audit and adversarial-testing record — it is **not** a
> third-party audit and is **not** a substitute for one. No finding in this
> report should be read as a guarantee of safety. See §8 (Residual Risk &
> Mainnet Readiness) for the honest disposition.
>
> **Scope snapshot (2026-07-02).** The counts in this report (20 contracts + 2
> libraries + 16 interfaces; 1,392 tests / 104 suites) are the surface **as of the
> report date** and are kept as the historical record. Two tokenization-kit
> contracts landed the day after (`Access0x1RwaToken` — ERC-7943, and
> `Access0x1Account` — ERC-6551, both 2026-07-03) with their own test suites,
> growing `src/` to 22 contracts + 2 libraries and the suite to 1,489 tests / 109
> suites; they are **not** covered by this report's manual review (§3–§7). Current
> counts: the README badge / a fresh `forge test`.
>
> **Tool-honesty note.** Both static analysers were executed over the `src/`
> surface; every result is triaged per-instance in [`audit/FINDINGS.md`](FINDINGS.md)
> (the curated record — the raw generated reports are gitignored). The counts quoted
> in this report (§2.1, §6) are the recorded dispositions, not a fresh "clean" claim:
> we record what the tools said and how each row is disposed. **Aderyn v0.1.9** runs
> from a checkout whose `node_modules`/`lib` resolve inside the project root — run
> from a worktree with those paths symlinked out of the tree it panics with
> `StripPrefixError` before emitting a report, so the Aderyn numbers were produced
> from a checkout with a local (non-symlinked) `node_modules`; it also prints a
> cosmetic version-parse panic *after* writing its report (it cannot parse the
> `foundry-zksync` version string), so the report itself is complete. `forge coverage`
> uses `--ir-minimum` (the commerce set trips `Stack too deep` otherwise).

---

## 1. Scope

The audited surface is the first-party Solidity in `src/` — **20 contracts + 2
libraries (`NameMath`, `OracleLib`) + 16 interfaces**. Dependencies (OpenZeppelin, Chainlink,
forge-std) are out of scope and excluded from the static analysers
(`slither.config.json` filters `lib/ node_modules/ test/ script/`; Aderyn runs
over `src/`).

**The money spine + the deep-review set:**

| Contract | Role on / off the money path |
| --- | --- |
| `Access0x1Router.sol` | The shared, multi-tenant, **zero-custody** money spine. `registerMerchant` -> `payNative`/`payToken` price USD->token via a Chainlink feed in-tx (with the optional L2 sequencer-uptime guard, §7.5), split an exact capped fee, push net -> merchant atomically. |
| `PaymentLanes.sol` | ERC-6909 non-custodial **pull** receipts; per-asset lane firewall + conservation. |
| `SessionGrant.sol` | ERC-7702 / ERC-6492 / ERC-1271 session authorisation. Holds **no funds**; enforces budget caps + expiry. |
| `Access0x1Subscriptions.sol` | Recurring-billing primitive. Plans/periods only; every charge pulls -> router split -> push and debits a `SessionGrant` budget meter. Holds ~zero balance. |
| `Access0x1Bookings.sol` | Deposit/escrow + cancel/no-show/expire lifecycle. Fully-backed escrow ledger; resolution fee re-quoted in-tx, **refund never blocked** (§7.3). |
| `Access0x1Invoices.sol` | One-shot invoice settlement. `OPEN -> {PAID\|VOID}` one-way; straight pull -> router -> split -> push, no escrow. |
| `Access0x1GiftCards.sol` | Closed-loop USD store credit. Holds **no** ERC-20 — a card balance is a pure USD receipt; the chargeable remainder settles through the router. |

**Additional first-party primitives (built + tested; compose the same spine):**

| Contract | Role on / off the money path |
| --- | --- |
| `Access0x1Nft.sol` | USD-priced zero-custody NFT-commerce: lists an ERC-721, `buy` pulls the quoted gross and settles through the router atomically; escrows only the listed NFT, never a payment token (§7.4). |
| `SplitSettler.sol` | N-payee revenue split — one USD-priced payment fans out to N payees by basis points, `Σ shares == gross`; net pull-credited per payee (ERC-6909, never-blockable); conservation `balance == Σ unclaimed`. |
| `Access0x1Escrow.sol` | Conditional-settlement: a deposit HELD until resolution, then RELEASED through the router fee-split or REFUNDED in full; CEI + `nonReentrant` + never-blockable pull-on-failure payout; conservation `balance == Σ open + Σ withdrawable`. |
| `Receivables.sol` | Tokenized, factorable invoices (ERC-721 the holder gets paid on); settles through the router. |
| `Refunds.sol` | Pull-pattern refund ledger — a refund is credited and claimed, never pushed into a hostile recipient. |
| `GaslessPayIn.sol` | Gas-free USDC pay-in (EIP-3009 / x402-style) settled through the router. |
| `PriceOracleAdapter.sol` | Adapter around the Chainlink read (the `OracleLib` staleness guard), so the price source is swappable without touching the spine. |
| `AutomationGateway.sol` | Keeper/automation entrypoint for the recurring legs (subscriptions). |
| `Access0x1ProvenanceRegistry.sol` | Append-only on-chain provenance/audit record. Off the money path. |
| `ChainRegistry.sol` | `Ownable2Step` registry of per-chain `usdc`/`router` + live flags. Off the money path. |
| `Access0x1Receiver.sol` | Chainlink-CRE "notified settlement" audit consumer. Off the money path (append-only audit log). |
| `HouseToken.sol` | Business-owned, closed-loop ERC-20 (loyalty / store credit). Owner-gated mint; Access0x1 never holds authority. |
| `HouseTokenFactory.sol` | Non-custodial deployer for `HouseToken`. No owner, no admin, no upgradeability. |
| `NameMath.sol` | Pure on-chain ENS brand layer (deterministic color + identicon SVG from a namehash). No state, no value. |
| `libraries/OracleLib.sol` | Chainlink staleness + completed-round guard + the L2 sequencer-uptime check (`internal`, inlined into the router). |
| `interfaces/*.sol` (16) | The published interface surface for the contracts above. |

These additional primitives carry their own invariant suites (`test/invariant/` — Escrow, GaslessPayIn,
Receivables, Refunds, SplitSettler) and adversarial tests (`test/attack/` — Escrow, Nft, and the router
ERC-777-reentrancy probe), and they re-route every money leg through `Access0x1Router.payToken`/`payNative`
+ `quote`, so the router's proven properties (conservation, zero-custody, isolation, fee cap) carry to them
unchanged.

---

## 2. Methodology

The contracts were assessed with four independent, overlapping techniques. The
governing rule for every static-tool result is the real-audit convention:
**resolve or justify — never silently suppress.**

1. **Foundry unit tests** — positive behaviour + every revert path for each
   contract (`test/unit/**`).
2. **Foundry invariant (fuzz) tests** — money-path invariants under
   `fail_on_revert = true`, so a swallowed revert is a test failure
   (`test/invariant/**`). §5 lists each one and what it means: 6 router + 3
   PaymentLanes + 6 Bookings + 6 Invoices + 6 Subscriptions + 4 GiftCards.
3. **Foundry adversarial / red-team tests** — exploit-only suites that attempt
   the actual attack and assert it reverts (`test/attack/**`).
4. **Foundry integration + fuzz tiers** — end-to-end commerce flows
   (`test/integration/**`) and property fuzz (`test/fuzz/**`) over the quartet.
5. **Static analysis** — Aderyn v0.1.9 (`--no-snippets`) and Slither v0.11.5,
   both scoped to `src/`.
6. **`forge coverage`** (`--ir-minimum`) — per-contract line/statement/branch/function coverage.
7. **Manual review** — CEI ordering, custody, oracle handling, access control,
   and the real issues in §7.

### 2.1 Gate result (this commit)

| Step | Result |
| --- | --- |
| `forge build` | **green** (solc 0.8.28, `via_ir`, `cancun`) |
| `forge test` | **1,392 tests passed, 0 failed, 0 skipped** (104 suites) — re-run for this report |
| `forge fmt --check` | **clean** |
| `forge coverage` | lines **~98%**, branches **~97%** on the router; functions **100%** overall (`--ir-minimum`; per-contract in §4 / [`COVERAGE.md`](COVERAGE.md)) |
| Invariants | hold under `fail_on_revert`, 0 reverts — the 6 router money invariants + the PaymentLanes firewall/conservation set + per-lifecycle invariants on the commerce primitives (Bookings, Invoices, Subscriptions, GiftCards, Escrow, GaslessPayIn, Receivables, Refunds, SplitSettler) |
| Halmos | symbolic fee-split conservation + SessionGrant budget-cap proofs pass (`make halmos`) |
| Aderyn | every High/Low **triaged** (false-positive / by-design / style) — per-instance in [`FINDINGS.md`](FINDINGS.md) |
| Slither | every result **triaged** (router native-send rows suppressed by inline `slither-disable`) — per-instance in [`FINDINGS.md`](FINDINGS.md) |

---

## 3. Security Posture

Access0x1's safety rests on a small number of deliberate, testable properties.

### 3.1 Zero custody (the central property)

Settlement on `Access0x1Router` is atomic: **pull -> split -> push, all in one
transaction.** The router never holds merchant value between transactions.
`PaymentLanes` is non-custodial in the other direction — value sits as an
ERC-6909 receipt the merchant **pulls**, never a balance the protocol controls.
`SessionGrant`, `NameMath`, `ChainRegistry` and `Access0x1Receiver` hold no
funds at all. `HouseToken`/`HouseTokenFactory` mint authority lives with the
business owner — Access0x1 has none. The **commerce quartet**
(`Access0x1Subscriptions`, `Access0x1Bookings`, `Access0x1Invoices`,
`Access0x1GiftCards`) composes this spine rather than re-deriving it: every money
leg routes through `Access0x1Router.payToken`/`payNative` and every USD->token
price is read in-tx through `Access0x1Router.quote`, so the router's proven
properties carry to them unchanged. Subscriptions/Invoices are straight
pull->router->split->push (no escrow); Bookings keeps a fully-backed escrow ledger
(contract balance == `escrowedOf`); GiftCards holds no ERC-20 at all. This is
enforced by the `invariant_zeroCustody`, `invariant_conservation*`, and
`invariant_escrowAlwaysBacked` fuzz invariants (§5).

### 3.2 Defence-in-depth controls

| Control | Where | Effect |
| --- | --- | --- |
| **CEI ordering** | `Access0x1Router.payToken/payNative`, `PaymentLanes` | State written before external value movement; pull-then-verify on token-in (balance-delta check rejects fee-on-transfer skims). |
| **`nonReentrant`** | every router entry point + `claimRescue` | One shared guard across all value-moving paths. |
| **`SafeERC20`** | router token legs (`using SafeERC20 for IERC20`) | Tolerates non-standard / no-return ERC-20s; reverts on failed transfer. |
| **Oracle staleness guard** | `OracleLib.staleCheckLatestRoundData` (inlined into `quote`) | Reverts `OracleLib__StalePrice` on `updatedAt == 0`, carried-over round (`answeredInRound < roundId`), or age `> TIMEOUT`. A stale price never becomes a quote. |
| **Capped fee** | router `MAX_FEE_BPS`, `FEE_DENOMINATOR = 10_000` | No payment is ever charged more than the cap; enforced by `invariant_feeCap`. |
| **Fail-soft payout** | `_pushNativeOrQueue` rescue credit | A rejecting payee never strands the tx; the receipt stands and value is rescuable — funds are never stuck. |
| **`Ownable2Step` + `Pausable`** | router, `ChainRegistry`, `PaymentLanes` | Two-step ownership (no single-tx hijack); pause halts new payments without touching settled value. |
| **Validated-nonce auth** | `SessionGrant._open` | Each authorisation is pinned to the nonce its signature was validated against (the §7.1 fix). |

### 3.3 Trust model (stated, not hidden)

Owners hold privileged setters (fees, treasury, allowlists, pause, chain/router
config). This is a **documented trust assumption** — a burner key at the event,
a multisig in production. Critically, **no owner path reaches merchant funds**:
router settlement is atomic and zero-custody, `PaymentLanes` admin holds no lane
balance, `SessionGrant` holds no funds, and `Access0x1Receiver` is off the money
path. This is the disposition for Aderyn L-1 / Slither centralization results
(§6), not a dismissal.

---

## 4. Per-contract test & coverage

The authoritative whole-suite total is the `forge test` line:
**1,392 passed / 0 failed / 0 skipped across 104 suites** (unit + attack + invariant
+ integration + fuzz + scenario + fork + symbolic). Per-contract coverage is measured
under `forge coverage --ir-minimum` (the commerce set trips `Stack too deep` under the
non-IR coverage pipeline); the raw snapshot below is captured in
[`COVERAGE.md`](COVERAGE.md), which is the source of truth for these numbers.

| Contract | % Lines | % Statements | % Branches | % Funcs |
| --- | --- | --- | --- | --- |
| `Access0x1Router.sol` | 97.87% | 98.14% | 97.50% | 100% |
| `PaymentLanes.sol` | 100% | 97.10% | 85.71% | 100% |
| `SessionGrant.sol` | 97.80% | 98.39% | 95.83% | 100% |
| `Access0x1Subscriptions.sol` | 100% | 99.30% | 96.00% | 100% |
| `Access0x1Bookings.sol` | 99.42% | 96.00% | 78.95% | 100% |
| `Access0x1Invoices.sol` | 100% | 100% | 100% | 100% |
| `Access0x1GiftCards.sol` | 96.43% | 96.51% | 80.95% | 100% |
| `Access0x1Nft.sol` | 96.30% | 94.83% | 90.00% | 100% |
| `ChainRegistry.sol` | 100% | 100% | 100% | 100% |
| `Access0x1Receiver.sol` | 92.00% | 92.59% | 66.67% | 100% |
| `HouseToken.sol` | 100% | 87.50% | 50% | 100% |
| `HouseTokenFactory.sol` | 100% | 100% | 100% | 100% |
| `NameMath.sol` | 100% | 100% | 100% | 100% |
| `OracleLib.sol` | 100% | 100% | 100% | 100% |
| **Measured total (this snapshot)** | **98.58%** | **97.65%** | **89.90%** | **100%** |

The per-contract snapshot above is the last full `--ir-minimum` coverage run committed
to [`COVERAGE.md`](COVERAGE.md); it predates the most recently-added primitives
(`SplitSettler`, `Access0x1Escrow`, `Receivables`, `Refunds`, `GaslessPayIn`,
`PriceOracleAdapter`, `AutomationGateway`, `Access0x1ProvenanceRegistry`), which each
carry their own unit/invariant/attack tests inside the 1,392-test whole-suite total and
refresh into this table on the next coverage run.

The sub-100% rows are **unreachable defence-in-depth guards**, documented and
intentionally kept (covering them would require weakening the contract):

- `Access0x1Bookings` branches (78.95%) — the best-effort `try/catch` catch-arms on
  the oracle-fault-tolerant resolution legs (`_trySafeQuote`, `_payoutOrQueue`); the
  refund-never-blocked fallback that fires only on a degraded feed or a rejecting
  payee, plus fee-clamp branches a fuzzed price never crosses (§7.3).
- `Access0x1Receiver` (92.00% / 66.67%) — the assembly-decode length pre-guard and a
  workflow-allowlist short-circuit the fixtures hit on one side.
- `Access0x1Router` (97.87%) — the `_pushNativeOrQueue` rescue-credit fallback arm,
  the native-payee-rejects path the honest fixtures don't trigger.
- `Access0x1Nft` (96.30% / 90%) — the `onERC721Received` unconditional-accept arm and
  the `EscrowFailed` defensive revert, reached only by a misbehaving collection.
- `PaymentLanes` constructor zero-owner revert — OZ `Ownable(address(0))` reverts
  first with `OwnableInvalidOwner`, so the custom revert is never reached
  (proven by `test_constructor_revertsOnZeroOwner`, which observes the OZ error).
- `SessionGrant._open` `SessionGrant__SessionExists` collision branch — the
  monotonic owner nonce plus the `NonceMismatch` guard make a same-nonce
  collision unreachable via the public API; kept as a clobber guard.
- `HouseToken` `decimals()` override branch — a defensive return that the
  fixtures exercise on one side; behaviour is identical (returns the
  construction-time `_DECIMALS`).

---

## 5. The fuzz invariants

Run under `[invariant] fail_on_revert = true` (64 runs x 4096 calls each in the
default profile; 256 x 128 in CI). A revert is a real failure — handlers bound
their inputs and early-return on invalid preconditions. The commerce primitives
each add their own lifecycle invariants; because every money leg routes through
the router, the router's six carry to them as well. The detailed sets below cover
the money spine + the deep-review set; the additional primitives
(`Access0x1Escrow`, `GaslessPayIn`, `Receivables`, `Refunds`, `SplitSettler`) each
carry their own invariant suite under [`test/invariant/`](../test/invariant/)
(e.g. Escrow conservation `balance == Σ open + Σ withdrawable`, SplitSettler
`balance == Σ unclaimed`, Refunds pull-ledger conservation).

**`Access0x1Router` (6) — the money spine:**

| Invariant | Meaning |
| --- | --- |
| `invariant_conservationNative` | For native pay: `net + platformFee + merchantFee == gross`, exactly — no wei created or lost. |
| `invariant_conservationToken` | The same conservation identity for ERC-20 pay legs. |
| `invariant_feeCap` | No payment is ever charged more than `MAX_FEE_BPS`. |
| `invariant_merchantIsolation` | A payment to one merchant never mutates another merchant's accounting. |
| `invariant_platformCutToTreasury` | The platform's cut always reaches the configured treasury — never a third party, never the router. |
| `invariant_zeroCustody` | The router holds no token balance between transactions (the core custody property). |

**`PaymentLanes` (3):** `invariant_conservationUsdc`, `invariant_conservationEurc`
(per-asset firewall — USDC never pays out as EURC), `invariant_canaryLaneFrozen`
(a deliberately frozen lane never accrues or releases). A second firewall handler
suite (`PaymentLanesFirewallInvariant`) re-proves conservation under scrambled
cross-asset claim attempts.

**`Access0x1Bookings` (6):** escrow conservation + always-backed
(`invariant_escrowAlwaysBacked`, `invariant_escrowConservation`), the fee never
exceeds the held escrow (`invariant_feeNeverExceedsEscrow`), the policy snapshot is
immutable after reserve (`invariant_policySnapshotImmutable`), the slot-isolation
canary (`invariant_canarySlotIsolation`), and settle-at-most-once
(`invariant_settlesAtMostOnce`).

**`Access0x1Invoices` (6):** routed amounts match the sinks
(`invariant_routedMatchesSinks`), settle-at-most-once
(`invariant_settlesAtMostOnce`), getters can't revert
(`invariant_gettersCantRevert`), the void canary stays void
(`invariant_voidCanaryStaysVoid`), and isolation/continue checks.

**`Access0x1Subscriptions` (6):** never past the `SessionGrant` budget
(`invariant_neverPastBudget`), period monotonicity (`invariant_periodMonotonic`),
the tier read is pure-view (`invariant_tierIsPureView`), the open canary stays
untouched (`invariant_openCanaryUntouched`), plus isolation/continue checks.

**`Access0x1GiftCards` (4):** card conservation per card
(`invariant_conservationCard0/1`), the coupon cap is never exceeded
(`invariant_couponCapNeverExceeded`), and the frozen-card canary
(`invariant_canaryCardFrozen`).

All held with **0 reverts** under `fail_on_revert` (a separate
`continueOnRevert` profile additionally fuzzes the router under revert-tolerant
handlers as a cross-check), inside the 1,392-test whole-suite total.

---

## 6. Findings

The full, current per-instance disposition lives in
[`audit/FINDINGS.md`](FINDINGS.md) — that tracker is the authoritative record
(it carries the rows added by `Access0x1Nft` and the router's L2 sequencer-uptime
guard, §7.5). The summary below is the dominant set of rows. **Severity** is the
analyser's claim; **Status** is the audited disposition. None of these is an
exploitable vulnerability in the deployed configuration.

### 6.1 Aderyn — 4 High + 11 Low (category counts), all triaged

Aderyn v0.1.9 ran over the `src/` surface; every High and Low is triaged
(false-positive / by-design / style). The **category counts (4H / 11L)** are stable
across the most recent additions — bringing `Access0x1Nft` and the router's sequencer
guard into scope added only *instances* of existing rows (see [`FINDINGS.md`](FINDINGS.md)
for the current instance counts). The dispositions are unchanged in kind.

| ID | Title (Aderyn) | Instances | Severity | Status |
| --- | --- | --- | --- | --- |
| H-1 | Arbitrary `from` in `transferFrom` / `safeTransferFrom` (`Access0x1Router` `_pullExact`, `Access0x1Invoices` `_pullExact`, `Access0x1Subscriptions` charge) | 3 | High | **False positive.** In every case `from`/`subscriber` is the payer threaded from the pay entrypoint (the address the contract pulls the pay-in from), not an attacker-chosen third party with a standing approval. Each pull is followed by a balance-delta check that rejects fee-on-transfer skims. |
| H-2 | Uninitialized state variable (`HouseTokenFactory.deployedCount`) | 1 | High | **False positive (style).** `deployedCount` is a counter; Solidity zero-initialises it. No money path; an explicit `= 0` adds nothing. |
| H-3 | Unprotected native-ETH send (`Access0x1Router` `payNative` refund, `claimRescue`) | 2 | High | **By design.** Recipients are caller-configured (zero-checked) merchant/treasury/fee/buyer addresses or `msg.sender`; the contract is `nonReentrant` + CEI. A payments router sending native value is its purpose. |
| H-4 | Unused return value (`Access0x1Subscriptions._charge` return; `sessionGrant.spend` return) | 2 | High | **False positive / benign.** `_charge` returns `gross` for the caller that needs it; the trial-skip path and the budget-meter call deliberately ignore the informational return. The state effect (the spend) is what matters and is not dropped. |
| L-1 | Centralization risk (owner setters + pause across all contracts) | 22 | Low | **By design (documented trust assumption, §3.3).** No owner path reaches merchant funds. |
| L-2 | Unsafe ERC20 operation (`Access0x1Bookings._payoutOrQueue` raw `.transfer`) | 1 | Low | **By design — the refund-never-blocked mechanism (§7.3).** The raw `.transfer` is wrapped in `try/catch`: a rejecting payee credits `_refundRescue` instead of bubbling. SafeERC20 would *revert* on a hostile token and brick the refund — the opposite of what money-safety invariant #5 requires. |
| L-3 | Missing `address(0)` check (`Access0x1Router.setPaymentLanes`) | 1 | Low | **By design.** `address(0)` is the deliberate "disable lanes" sentinel (documented inline). |
| L-4 | `public` could be `external` (`Receiver.supportsInterface`, `HouseToken.decimals`) | 2 | Low | **False positive.** Both are `override`s of base interfaces that must stay `public`. |
| L-5 | Literals could be constants (router scaling, NameMath SVG math, SessionGrant 6492 offsets, Bookings scaling) | 15 | Low | **Idiomatic.** Decimal-scaling bases, SVG geometry constants and signature byte offsets, not magic numbers. |
| L-6 | Events missing `indexed` fields | 25 | Low | **By design.** Indexing targets only fields indexers filter on; over-indexing wide audit/settlement events wastes gas. |
| L-7 | Modifier invoked only once (`Access0x1Subscriptions`) | 1 | Low | **By design.** The named modifier documents the merchant-owner authorization gate; inlining hurts readability with no gas/behaviour impact. |
| L-8 | Large literal `FEE_DENOMINATOR = 10_000` | 1 | Low | **Intentional.** Reads as a basis-point denominator; underscore-grouped and named. |
| L-9 | Internal functions called once could be inlined (3x `NameMath`) | 3 | Low | **By design.** Named helpers keep the pure-SVG math readable; via-IR inlines them anyway. |
| L-10 | Unused custom error (`ChainRegistry__ZeroAddress`) | 1 | Low | **By design.** Reserved shared error for consumers enforcing non-zero `usdc`/`router`; part of the published surface. |
| L-11 | Redundant statement (`SessionGrant` `ok;`) | 1 | Low | **By design.** Documents that the best-effort ERC-6492 prepare result is intentionally ignored (inline comment). |

### 6.2 Slither — all results triaged

Slither v0.11.5 analyses `src/` (`slither.config.json` filters `lib/`,
`node_modules/`, `test/`, `script/`). Every result is triaged — the
authoritative, current result count and per-detector list is in
[`FINDINGS.md`](FINDINGS.md) (which carries the rows added by `Access0x1Nft` and
the router's sequencer-guard setter). The router's `arbitrary-send-eth` and
`reentrancy-eth` rows do **not** appear in the result list — they are suppressed
at source by inline `slither-disable` directives (the by-design native-send
paths, the same disposition as Aderyn H-3). That suppression is disclosed here
rather than hidden. The dominant detector dispositions:

| Detector | Where | Status |
| --- | --- | --- |
| `incorrect-equality` | `Access0x1Bookings._payoutOrQueue` (`amount == 0`) | **False positive.** A strict `== 0` early-return on an exact internal value, not a balance/timestamp comparison; there is no rounding or external influence on `amount`. |
| `reentrancy-no-eth` / `reentrancy-benign` / `reentrancy-events` | `SessionGrant.openSessionFor` (the ERC-6492 `factory.call` before the nonce write); `Access0x1Bookings._payoutOrQueue` (rescue credit after the best-effort `transfer`) | **Justified — non-exploitable, guarded at runtime.** The 6492 prepare reentrancy is real; the `NonceMismatch` guard (§7.1) pins each authorisation to its validated nonce so a re-entrant open can neither double-open nor advance the nonce twice. The Bookings post-call write is the fail-soft rescue credit on a rejecting payee; the function is `nonReentrant` and the credit only grows a per-(payee,token) escrowed balance. CEI holds where value can actually move. |
| `uninitialized-local` | `Access0x1Router.quote` (`feedDecimals`/`tokenDecimals`), `Access0x1Bookings._cancel` (`feeTarget`) | **False positive.** Each is assigned on every reachable path before use (the decimals are read from the feed/token; `feeTarget` is set from the `_trySafeQuote` result, defaulting to zero on a fault). Marked with inline `slither-disable` where the default-zero is intentional. |
| `unused-return` | `Access0x1Bookings/Invoices/GiftCards._merchantOwner` (`router.merchants(...)` tuple); `SessionGrant._validate1271OrEOA{,Calldata}` (`ECDSA.tryRecover`) | **False positive.** The quartet helpers read only the `owner` field of the merchant struct for an authorization check — the other tuple slots are deliberately dropped. The validators use the recovered address + error, dropping only the unused tuple slot (canonical `tryRecover` usage). |
| `shadowing-local` | `IAccess0x1GiftCards` param `cardId` vs the `cardId(...)` view; `ISessionGrant.remaining(bytes32)` return name | **False positive / cosmetic.** A parameter or named return matching an interface function name shadows no state or parent symbol; it is an interface-declaration artifact only. |
| `timestamp` | `OracleLib`; `SessionGrant.remaining/_open/spend`; `Access0x1Bookings.expireHold/cancelWithSession/_cancel` | **By design.** Comparing `block.timestamp` to a staleness window / session expiry / booking cancel-window IS the intended guard; minute-scale validator drift cannot defeat the hour-plus / slot-scale bounds. |
| `assembly` | `Access0x1Receiver._decodeMetadata` | **By design.** Fixed-offset calldata slicing of the Keystone metadata layout, guarded by `require(metadata.length >= 62)`. No memory writes, no dynamic offsets. |
| `low-level-calls` | `SessionGrant._isValidSignatureNow` (6492 `factory.call`), `_validate1271OrEOA{,Calldata}` (1271 `staticcall`) | **By design.** ERC-6492/ERC-1271 require exactly these calls; the 1271 path is a no-state `staticcall`, the 6492 prepare is best-effort behind the magic suffix. |
| `naming-convention` | `Receiver.i_forwarder`, `HouseToken._DECIMALS` | **By design.** `i_` immutable / `_` constant are the project (Cyfrin) conventions; documented in the storage-layout note. |
| `redundant-statements` | `SessionGrant` `ok;` | **By design.** Same as Aderyn L-11. |

---

## 7. Real issues found and fixed during the build

Three genuine defects were found by adversarial testing during the build and
fixed. Each has regression tests; no existing test was weakened.

### 7.1 SessionGrant — ERC-6492-prepare reentrancy double-open (High, fixed)

**The bug.** `openSessionFor` validated the grant signature against the owner
nonce read at entry, but `_open` then *re-read* `_nonces[owner]` to derive the
session id. The only external call in the contract is the ERC-6492 factory
"prepare" inside `_isValidSignatureNow`, fired **before** the nonce write. A
malicious factory could re-enter `openSessionFor`, open a session at nonce N
(bumping it to N+1), and on return the outer `_open` re-read N+1 and opened a
**second** session at a nonce the signature never authorised — one grant opening
two sessions (an auth-integrity break).

**The fix** (`fix(SessionGrant): pin open to the validated nonce`, commit
`e91a8b4`). `_open` now takes the *validated* nonce as a parameter and reverts
`SessionGrant__NonceMismatch` if the live nonce has moved. A re-entrant advance
makes the outer open revert and roll back the whole transaction -> the malicious
grant opens **zero** sessions and the nonce never double-advances. Honest direct
/ relayed / 6492 paths are unchanged.

**Proof.** `test/attack/SessionGrant.attack.t.sol::test_attack_reentrancy_6492_cannotDoubleOpen`
(attack reverts with `NonceMismatch(owner, 0, 1)`) and
`test_reentrancy_honest6492_opensExactlyOne` (positive control). The reentrant
factory mock is `test/mocks/ReentrantSessionFactory.sol`.

### 7.2 Web — `/api/quote` input-validation bypass (money-adjacent, fixed)

**The bug.** `GET /api/quote` parsed query params before any chain/contract
call. `Number(chainId)` yields `NaN` for junk input *without throwing*, so a
non-numeric `chainId` slipped past the numeric guard and surfaced as a confusing
500 from `getRouterAddress(NaN)`. `BigInt()` rejects non-integers but **accepts
negatives**, so a negative/zero price (`usdAmount8`) or negative `merchantId`
reached the contract path — a violation of the project's law #4 (*never a silent
wrong price*).

**The fix** (`harden web money-adjacent paths: quote input validation`, commit
`49203a9`, merged in `15aa945`). `chainId` must be a finite positive integer,
`merchantId` must be non-negative, and `usdAmount8` must be a positive amount —
each returning a clean `400` *before* any chain/contract call. A negative or
zero price is never quoted.

**Proof.** `web/app/api/quote/__tests__/quote.route.test.ts` (NaN / zero /
negative / fractional `chainId`, non-integer and negative `merchantId` /
`usdAmount8` -> 400) plus `web/__tests__/quote-lib.test.ts` (USD<->amount8 float-
safe round-trip; `fetchQuote` always `no-store` so no stale price reaches the
buyer; stale/revert/non-ok status surfaces as an error, never a usable quote).
The same hardening pass added adversarial coverage for the agent SSRF allowlist,
the x402 seller spine (replay / amount-mismatch / authoritative-amount), and the
agent spend meter.

### 7.3 Access0x1Bookings — stale-oracle refund-block (High, fixed)

**The bug.** A booking escrows a USD-priced deposit and later resolves through
`cancel` / `noShow` (take a policy fee, refund the remainder) or `expireHold`
(refund in full). To stop price-drift gaming, the **fee leg re-quotes** the USD
policy fee -> token through `Access0x1Router.quote` at resolution time. But `quote`
applies the `OracleLib` staleness guard and **reverts** on a stale / dead / zero
feed — or if the token was de-allowlisted between reserve and resolution. If that
revert bubbled, an oracle outage would brick the cancel/no-show transition **and
therefore the payer's refund** — value stranded in escrow exactly when settlement
infrastructure is degraded. This violates money-safety invariant #5 (*money paths roll back,
never swallow; refunds are never blocked*).

**The fix** (`fix(Bookings): make the resolution fee leg oracle-fault-tolerant`).
The re-quote on the **resolution** legs is wrapped in `_trySafeQuote` (a
`try/catch` around `router.quote`). A revert surfaces as `ok == false` instead of
bubbling; the fee target then falls to **zero**, the operator takes nothing, and the
full escrow flows back to the payer. The payout itself uses `_payoutOrQueue` — a
best-effort `transfer` in `try/catch` that credits a claimable `_refundRescue`
balance if the payee rejects, so even a hostile payee cannot brick the refund.
Crucially `reserve` does **not** do this — you must never escrow against a bad
price, so only the resolution/refund paths are fault-tolerant; a fresh booking
against a stale feed still reverts at `reserve`. The fee is additionally **clamped
to the held escrow**, so the payer refund can never go negative even on a price
spike.

**Proof.** `test/attack/Access0x1Bookings.attack.t.sol`:
`test_attack_staleOracleDoesNotBlockLateCancelRefund`,
`test_attack_staleOracleDoesNotBlockNoShowRefund`,
`test_attack_staleOracleDoesNotStrandCompleteDeposit`,
`test_attack_blockedRefundCannotBrickCancel`,
`test_attack_lateFeeNeverExceedsEscrow`, and the negative control
`test_attack_stalePriceBlocksReserve` (reserve still reverts on a stale feed). The
`invariant_feeNeverExceedsEscrow` / `invariant_escrowAlwaysBacked` fuzz invariants
(§5) carry the clamp + conservation properties across the whole lifecycle.

### 7.4 The commerce quartet — composition review (no new findings)

`Access0x1Subscriptions`, `Access0x1Bookings`, `Access0x1Invoices`, and
`Access0x1GiftCards` were reviewed against the project's money-safety invariants plus both static
tools. They are primitives that **compose** the audited spine rather than
re-deriving it:

- **No re-derived fee math.** Every money leg routes through
  `Access0x1Router.payToken` / `payNative`, so `net + platformFee + merchantFee ==
  gross` stays the router's proven invariant. The quartet owns lifecycle /
  eligibility only and holds ~zero token balance after each settlement.
- **Zero custody.** Subscriptions/Invoices are straight pull->router->split->push
  (no escrow). Bookings keeps a fully-backed escrow ledger (contract balance ==
  `escrowedOf`). GiftCards holds **no** ERC-20 at all — a card balance is a pure USD
  receipt; the chargeable remainder settles through the router separately.
- **Never-negative.** Subscriptions debits a `SessionGrant` budget that hard-reverts
  past the cap; GiftCards `redeem` reverts unless `balance >= applied`; Bookings
  clamps every fee to the held escrow.
- **Idempotency / single-settlement.** Invoices' `OPEN -> {PAID|VOID}` is one-way and
  absorbing; Bookings guards a `clientNonce`; GiftCards records each redemption id
  once.
- **Tenant isolation inherited.** Owner-authorization is read live from
  `Access0x1Router.merchants(id).owner` (the single registry); no quartet path mutates
  another merchant's or record's storage.

The quartet's static-tool rows (H-1, H-4, L-2, `incorrect-equality`,
`reentrancy-benign`, `timestamp`, `unused-return`) all map onto the dispositions in
§6 — by design / false-positive — and add no new untriaged finding. The same review
was applied to the later primitives (`Access0x1Nft`, `SplitSettler`,
`Access0x1Escrow`, `Receivables`, `Refunds`, `GaslessPayIn`): each holds ~zero
payment-token balance after settlement, routes its money leg through the router, and
keeps refunds/payouts on a never-blockable pull path — `Access0x1Nft.cancelListing`
is deliberately un-pausable so an unsold NFT is never hostage, and its
`buy(listingId, maxPriceUsd8)` requires explicit buyer price consent to defeat a
seller bump (`FINDINGS.md` carries the per-instance disposition).

### 7.5 Access0x1Router — L2 sequencer-uptime guard (added, M-1)

**The risk.** `quote()` reads a Chainlink price feed in the settlement tx. On an
Arbitrum/Optimism/Base-style L2 the feed is only as trustworthy as the sequencer that
posts it: during a sequencer outage the feed stops updating, and on restart the first
prices can be stale or manipulable — a feed can read "fresh" by `updatedAt` yet sit
behind a sequencer that just came back. The staleness guard alone does not cover this.

**The fix** (`feat(router): L2 sequencer-uptime guard on quote()`). `OracleLib` gains
`checkSequencerUp` — Chainlink's L2 Sequencer-Uptime pattern: `answer == 0` ⇒ up,
`== 1` ⇒ `OracleLib__SequencerDown`; `startedAt == 0` (no round posted) ⇒ down; and the
sequencer must have been continuously up past a 1-hour grace window or the quote reverts
`OracleLib__SequencerGracePeriodNotOver`. The router holds an optional
`sequencerUptimeFeed` (owner `setSequencerUptimeFeed` + event) and runs the check in
`quote()` **only when the feed is set**. With no feed configured — the default, and on
L1 / Arc (no sequencer) — the check is skipped and behaviour is byte-for-byte unchanged,
so the existing money invariants and the full pre-existing suite carry over untouched.
The guard adds no value path and no custody surface — it can only *reject* a quote, never
alter settlement math.

**Proof.** `test/unit/SequencerGuard.t.sol` (up-past-grace, explicit-up, down→revert,
within-grace→revert, exact-grace-boundary→revert, uninitialized `startedAt==0`→revert,
unset-feed-skips, owner-gated setter, set/clear).

### 7.6 @access0x1/react — usePayment receipt-binding + timeout (SDK hardening)

**The risk.** `usePayment` watches the router's `PaymentReceived` event to populate the
receipt after a pay tx is mined. The event indexes only `{merchantId, buyer}`; `orderId`
is **not** indexed. So a concurrent payment by the same buyer to the same merchant for a
**different** order (e.g. a second open checkout tab) could resolve the hook with the
wrong receipt — wrong order, wrong amount. Separately, if the event never arrived or a log
failed to decode, the pay flow would `await` the receipt watch forever.

**The fix.** The hook now (a) **binds the watched receipt to this payment's `orderId`** —
it decodes each matching log and only resolves when `receipt.orderId === orderIdHex`
(both viem-lowercase bytes32, so `===` is exact), and (b) **races the receipt watch
against a 120s timeout** so a missing/undecodable event fails loud instead of hanging
(the watcher is torn down in `finally` either way). Both are in
`packages/react/src/hooks/usePayment.ts`; covered by
`packages/react/src/hooks/usePayment-timeout.test.ts`. This is a frontend correctness fix
(a UI could otherwise show a buyer the wrong on-chain receipt) — it does not touch any
contract or change settlement, which remains the router's atomic zero-custody path.

---

## 8. Residual risk & mainnet readiness

This section is intentionally conservative.

- **Status at the event: testnet-only.** The CREATE3 mirror is live on eight
  **testnets** (Arc, Base Sepolia, Ethereum Sepolia, Optimism Sepolia, Avalanche
  Fuji, Robinhood Chain, Arbitrum Sepolia, Celo Sepolia) with testnet USDC/EURC and
  testnet Chainlink feeds; three earlier chains carry pre-mirror per-chain deploys.
  **No mainnet deployment ships at the event, and we make no mainnet claim.**
- **This is not a third-party audit.** It is an internal engineering audit backed
  by 1,392 tests (0 failed), the money-path fuzz invariants, Halmos symbolic proofs,
  and two static analysers. Strong coverage reduces — but does not eliminate — risk.
  Logic the tests didn't imagine is the residual exposure that only an independent
  audit reliably finds.
- **Known residual risks:**
  - **Owner trust (centralization).** Owners can pause and reconfigure
    fees/treasury/allowlists/chains. No owner path reaches merchant funds (§3.3),
    but a compromised owner key can halt service and redirect *future* platform
    fees. Mitigation in prod: multisig + timelock.
  - **Oracle dependency.** Pricing trusts the configured Chainlink feed within
    the staleness window. A feed that is wrong-but-fresh would misprice; the
    guard only defends against staleness/incomplete rounds, not oracle
    correctness.
  - **ERC-6492 external call.** `SessionGrant` makes a best-effort call to a
    caller-supplied factory. The reentrancy is closed (§7.1); the call remains an
    untrusted external interaction, bounded by the validated-nonce pinning and
    the fact that the contract holds no funds.
  - **`HouseToken` is business-controlled.** Its mint authority is the business
    owner's, by design — Access0x1 makes no safety claim about how a business
    operates its own closed-loop token.
- **Mainnet readiness statement.** Mainnet deployment is **gated on an
  independent third-party security audit** of the full `src/` set, plus a
  monitored canary and a multisig/timelock owner. Until then the contracts are
  testnet-only. We do not claim mainnet-grade assurance from this report.

---

*Part of the Access0x1 build (ETHGlobal NY 2026) over the full first-party `src/`
surface (20 contracts + 2 libraries + 16 interfaces). Whole-suite gate at this
update: `forge test` = **1,392 passed / 0 failed / 0 skipped across 104 suites**.
Analyser versions: Aderyn v0.1.9, Slither v0.11.5, Foundry forge 1.3.5 / solc 0.8.28
/ EVM cancun, plus Halmos for the symbolic proofs. Every static-tool result is
triaged per-instance in `audit/FINDINGS.md` (the authoritative, current tracker);
Aderyn is run from a checkout with a local `node_modules` (it panics with
`StripPrefixError` when those paths symlink outside the project root, and prints a
cosmetic version-parse panic after writing its report). `forge coverage` runs with
`--ir-minimum`. The raw Aderyn report is gitignored; `audit/FINDINGS.md` is the
curated per-instance record and `audit/COVERAGE.md` is the raw coverage snapshot.*
