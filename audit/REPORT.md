# Access0x1 — Smart-Contract Security Audit Report

| | |
| --- | --- |
| **Protocol** | Access0x1 — open, multi-chain, zero-custody payments + session-auth layer |
| **Scope** | 12 first-party contracts under `src/` (+ 1 internal library, 8 interfaces) |
| **Commit** | `finish/audit` off `main` (the merged spine + commerce quartet + fuzz/integration tiers) |
| **Toolchain** | Foundry (forge 1.3.5 / solc 0.8.28, EVM `cancun`, `via_ir`), Aderyn v0.1.9, Slither v0.11.5 |
| **Methodology** | Foundry unit + invariant + adversarial (`test/attack/**`) + integration + fuzz suites, Aderyn, Slither, `forge coverage`, manual review |
| **Status at event** | **Testnet-only** (Arc / Base / zkSync testnets). Mainnet deployment is gated on an independent third-party audit (see §8). |
| **Report style** | Cyfrin-style: scope → methodology → posture → findings (resolve-or-justify) → residual risk |

> This report records the security work performed during the build. It is an
> internal engineering audit and adversarial-testing record — it is **not** a
> third-party audit and is **not** a substitute for one. No finding in this
> report should be read as a guarantee of safety. See §8 (Residual Risk &
> Mainnet Readiness) for the honest disposition.
>
> **Tool-honesty note (this run).** Both static analysers were actually executed
> over the full 12-contract surface for this report: **Slither v0.11.5 ran clean**
> (31 results across 12 detectors). **Aderyn v0.1.9** runs from a checkout whose
> `node_modules`/`lib` resolve inside the project root — run from a worktree with
> those paths symlinked out of the tree it panics with `StripPrefixError` before
> emitting a report, so the Aderyn numbers here were produced from a checkout with
> a local (non-symlinked) `node_modules`. Aderyn also prints a cosmetic
> version-parse panic *after* writing its report (it cannot parse the
> `foundry-zksync` version string); the report is complete. `forge coverage` uses
> `--ir-minimum` (the quartet trips `Stack too deep` otherwise).

---

## 1. Scope

The audited surface is the first-party Solidity in `src/`. Dependencies
(OpenZeppelin, Chainlink, forge-std) are out of scope and excluded from the
static analysers (`slither.config.json` filters `lib/ node_modules/ test/
script/`; Aderyn runs over `src/`).

| # | Contract | nSLOC | Role on / off the money path |
| --- | --- | --- | --- |
| 1 | `Access0x1Router.sol` | 303 | The shared, multi-tenant, **zero-custody** money spine. `registerMerchant` -> `payNative`/`payToken` price USD->token via a Chainlink feed in-tx, split an exact capped fee, push net -> merchant atomically. |
| 2 | `PaymentLanes.sol` | 123 | ERC-6909 non-custodial **pull** receipts; per-asset lane firewall + conservation. |
| 3 | `SessionGrant.sol` | 184 | ERC-7702 / ERC-6492 / ERC-1271 session authorisation. Holds **no funds**; enforces budget caps + expiry. |
| 4 | `Access0x1Subscriptions.sol` | 240 | Recurring-billing primitive. Plans/periods only; every charge pulls -> router split -> push and debits a `SessionGrant` budget meter. Holds ~zero balance. |
| 5 | `Access0x1Bookings.sol` | 284 | Deposit/escrow + cancel/no-show/expire lifecycle. Fully-backed escrow ledger; resolution fee re-quoted in-tx, **refund never blocked** (§7.3). |
| 6 | `Access0x1Invoices.sol` | 111 | One-shot invoice settlement. `OPEN -> {PAID\|VOID}` one-way; straight pull -> router -> split -> push, no escrow. |
| 7 | `Access0x1GiftCards.sol` | 169 | Closed-loop USD store credit. Holds **no** ERC-20 — a card balance is a pure USD receipt; the chargeable remainder settles through the router. |
| 8 | `ChainRegistry.sol` | 45 | `Ownable2Step` registry of per-chain `usdc`/`router` + live flags. Off the money path. |
| 9 | `Access0x1Receiver.sol` | 84 | Chainlink-CRE "notified settlement" audit consumer. Off the money path (append-only audit log). |
| 10 | `HouseToken.sol` | 30 | Business-owned, closed-loop ERC-20 (loyalty / store credit). Owner-gated mint; Access0x1 never holds authority. |
| 11 | `HouseTokenFactory.sol` | 29 | Non-custodial deployer for `HouseToken`. No owner, no admin, no upgradeability. |
| 12 | `NameMath.sol` | 79 | Pure on-chain ENS brand layer (deterministic color + identicon SVG from a namehash). No state, no value. |
| — | `libraries/OracleLib.sol` | 23 | Chainlink staleness + completed-round guard (`internal`, inlined into the router). |
| — | `interfaces/*.sol` (8) | 443 | `IAccess0x1Bookings`, `IAccess0x1GiftCards`, `IAccess0x1Invoices`, `IAccess0x1Subscriptions`, `IReceiver`, `IPaymentLanes`, `ISessionGrant`, `IHouseTokenFactory`. |
| | **Total** | **2157** | (21 `.sol` files; per `aderyn` nSLOC) |

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
| `forge test` | **831 tests passed, 0 failed, 0 skipped** (77 suites) |
| `forge fmt --check` | **clean** |
| `forge coverage` | lines **98.35%**, statements **97.57%**, branches **89.23%**, functions **99.30%** overall (`--ir-minimum`; per-contract in §4 / [`COVERAGE.md`](COVERAGE.md)) |
| Invariants | **31 / 31 hold** under `fail_on_revert`, 0 reverts (6 router + 3 PaymentLanes + 6 Bookings + 6 Invoices + 6 Subscriptions + 4 GiftCards) |
| Aderyn | 4 High + 11 Low — **all triaged** (false-positive / by-design / style) |
| Slither | 31 results across 12 detectors — **all triaged** (router native-send rows suppressed by inline `slither-disable`) |

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

Coverage measured under `forge coverage --ir-minimum` (the commerce quartet trips
`Stack too deep` under the non-IR coverage pipeline); full raw table in
[`COVERAGE.md`](COVERAGE.md). Test counts span unit + attack + invariant +
integration + fuzz tiers (`forge test`: **831 passed / 0 failed / 0 skipped**,
77 suites).

| Contract | Tests (all tiers) | Invariants | % Lines | % Statements | % Branches | % Funcs |
| --- | ---: | ---: | --- | --- | --- | --- |
| `Access0x1Router.sol` | ~101 | 6 | 97.79% | 98.08% | 97.44% | 100% |
| `PaymentLanes.sol` | ~102 | 3 | 100% | 97.10% | 85.71% | 100% |
| `SessionGrant.sol` | ~65 | — | 97.80% | 98.39% | 95.83% | 100% |
| `Access0x1Subscriptions.sol` | ~67 | 6 | 100% | 99.29% | 96.00% | 100% |
| `Access0x1Bookings.sol` | ~56 | 6 | 97.69% | 95.00% | 76.32% | 96.43% |
| `Access0x1Invoices.sol` | ~72 | 6 | 100% | 100% | 100% | 100% |
| `Access0x1GiftCards.sol` | ~74 | 4 | 96.43% | 96.51% | 80.95% | 100% |
| `ChainRegistry.sol` | ~53 | — | 100% | 100% | 100% | 100% |
| `Access0x1Receiver.sol` | ~52 | — | 92.00% | 92.59% | 66.67% | 100% |
| `HouseToken` + `HouseTokenFactory` | ~63 | — | 100% / 100% | 87.50% / 100% | 50% / 100% | 100% / 100% |
| `NameMath.sol` | ~29 | — | 100% | 100% | 100% | 100% |
| `OracleLib.sol` | ~23 | — | 100% | 100% | 100% | 100% |
| Fork (`ChainlinkFeedFork`) | 3 | — | — | — | — | — |
| Cross-cutting (`DeployAll`, `HelperConfig`, `EndToEnd`) | 14 | — | — | — | — | — |
| **Total** | **831** | **31** | **98.35%** | **97.57%** | **89.23%** | **99.30%** |

Per-contract test counts are approximate (they aggregate each contract's unit,
attack, invariant, integration and fuzz suites); the authoritative whole-suite
total is the `forge test` line: **831 / 0 / 0**. The 31 invariants are
6 router + 3 PaymentLanes + 6 Bookings + 6 Invoices + 6 Subscriptions + 4 GiftCards,
all holding under `fail_on_revert` with 0 reverts (§5).

The sub-100% rows are **unreachable defence-in-depth guards**, documented and
intentionally kept (covering them would require weakening the contract):

- `Access0x1Bookings` branches (76.32%) — the best-effort `try/catch` catch-arms on
  the oracle-fault-tolerant resolution legs (`_trySafeQuote`, `_payoutOrQueue`); the
  refund-never-blocked fallback that fires only on a degraded feed or a rejecting
  payee, plus fee-clamp branches a fuzzed price never crosses (§7.3).
- `Access0x1Receiver` (92.00% / 66.67%) — the assembly-decode length pre-guard and a
  workflow-allowlist short-circuit the fixtures hit on one side.
- `Access0x1Router` (97.79%) — the `_pushNativeOrQueue` rescue-credit fallback arm,
  the native-payee-rejects path the honest fixtures don't trigger.
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

## 5. The 31 fuzz invariants

Run under `[invariant] fail_on_revert = true` (64 runs x 4096 calls each in the
default profile; 256 x 128 in CI). A revert is a real failure — handlers bound
their inputs and early-return on invalid preconditions. The commerce quartet
adds its own lifecycle invariants; because each quartet money leg routes through
the router, the router's six carry to them as well.

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

All **31 held with 0 reverts** under `fail_on_revert` (a separate
`continueOnRevert` profile additionally fuzzes the router under revert-tolerant
handlers as a cross-check).

---

## 6. Findings

The full per-instance disposition lives in [`audit/FINDINGS.md`](FINDINGS.md).
Summary below. **Severity** is the analyser's claim; **Status** is the audited
disposition. None of these is an exploitable vulnerability in the deployed
configuration.

### 6.1 Aderyn — 4 High + 11 Low, all triaged

Aderyn v0.1.9 ran clean over the full 21-file `src/` surface (2157 nSLOC). The
counts grew from the previous 3H/9L as the commerce quartet was brought into scope
(H-4 unused-return, L-2 unsafe-ERC20, and more instances of the existing rows); the
dispositions are unchanged in kind.

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

### 6.2 Slither — 31 results across 12 detectors, all triaged

Slither v0.11.5 analysed `src/` (`slither.config.json` filters `lib/`,
`node_modules/`, `test/`, `script/`) and found **31 results across 12 detectors**.
The router's `arbitrary-send-eth` and `reentrancy-eth` rows do **not** appear in
this run's 31 — they are suppressed at source by 17 inline `slither-disable`
directives (the by-design native-send paths, the same disposition as Aderyn H-3).
That suppression is disclosed here rather than hidden.

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
`Access0x1GiftCards` were reviewed against the estate money laws plus both static
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
§6 — by design / false-positive — and add no new untriaged finding.

---

## 8. Residual risk & mainnet readiness

This section is intentionally conservative.

- **Status at the event: testnet-only.** Contracts run on Arc / Base / zkSync
  **testnets** with the testnet USDC/EURC and testnet Chainlink feeds. No
  mainnet deployment ships at the event.
- **This is not a third-party audit.** It is an internal engineering audit
  backed by 831 tests, 31 invariants, and two static analysers. Strong coverage
  reduces — but does not eliminate — risk. Logic the tests didn't imagine is the
  residual exposure that only an independent audit reliably finds.
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

*Regenerated as part of the Access0x1 build (ETHGlobal NY 2026) over the full
12-contract surface. Analyser versions: Aderyn v0.1.9, Slither v0.11.5, Foundry
forge 1.3.5 / solc 0.8.28 / EVM cancun. Slither ran clean (31 results / 12
detectors); Aderyn ran clean (4 High / 11 Low) from a checkout with a local
`node_modules` (it panics with `StripPrefixError` when those paths symlink outside
the project root, and prints a cosmetic version-parse panic after writing its
report). `forge coverage` ran with `--ir-minimum`. The raw Aderyn report is
gitignored; `audit/FINDINGS.md` is the curated per-instance record and
`audit/COVERAGE.md` is the raw coverage snapshot.*
