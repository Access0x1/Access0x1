# Access0x1 — Smart-Contract Security Audit Report

| | |
| --- | --- |
| **Protocol** | Access0x1 — open, multi-chain, zero-custody payments + session-auth layer |
| **Scope** | 8 first-party contracts under `src/` (+ 1 internal library, 4 interfaces) |
| **Commit** | `proc-security/audit-report` off `main` (Merge of web-harden + name-math + house-token + gas + cre + polish) |
| **Toolchain** | Foundry (solc 0.8.28, EVM `cancun`, `via_ir`), Aderyn v0.1.9, Slither v0.11.5 |
| **Methodology** | Foundry unit + invariant + adversarial (`test/attack/**`) suites, Aderyn, Slither, `forge coverage`, manual review |
| **Status at event** | **Testnet-only** (Arc / Base / zkSync testnets). Mainnet deployment is gated on an independent third-party audit (see §8). |
| **Report style** | Cyfrin-style: scope → methodology → posture → findings (resolve-or-justify) → residual risk |

> This report records the security work performed during the build. It is an
> internal engineering audit and adversarial-testing record — it is **not** a
> third-party audit and is **not** a substitute for one. No finding in this
> report should be read as a guarantee of safety. See §8 (Residual Risk &
> Mainnet Readiness) for the honest disposition.

---

## 1. Scope

The audited surface is the first-party Solidity in `src/`. Dependencies
(OpenZeppelin, Chainlink, forge-std) are out of scope and excluded from the
static analysers (`slither.config.json` filters `lib/ node_modules/ test/
script/`; Aderyn runs over `src/`).

| # | Contract | nSLOC | Role on / off the money path |
| --- | --- | --- | --- |
| 1 | `Access0x1Router.sol` | 289 | The shared, multi-tenant, **zero-custody** money spine. `registerMerchant` -> `payNative`/`payToken` price USD->token via a Chainlink feed in-tx, split an exact capped fee, push net -> merchant atomically. |
| 2 | `PaymentLanes.sol` | 123 | ERC-6909 non-custodial **pull** receipts; per-asset lane firewall + conservation. |
| 3 | `SessionGrant.sol` | 184 | ERC-7702 / ERC-6492 / ERC-1271 session authorisation. Holds **no funds**; enforces budget caps + expiry. |
| 4 | `ChainRegistry.sol` | 45 | `Ownable2Step` registry of per-chain `usdc`/`router` + live flags. Off the money path. |
| 5 | `Access0x1Receiver.sol` | 84 | Chainlink-CRE "notified settlement" audit consumer. Off the money path (append-only audit log). |
| 6 | `HouseToken.sol` | 30 | Business-owned, closed-loop ERC-20 (loyalty / store credit). Owner-gated mint; Access0x1 never holds authority. |
| 7 | `HouseTokenFactory.sol` | 29 | Non-custodial deployer for `HouseToken`. No owner, no admin, no upgradeability. |
| 8 | `NameMath.sol` | 79 | Pure on-chain ENS brand layer (deterministic color + identicon SVG from a namehash). No state, no value. |
| — | `libraries/OracleLib.sol` | 23 | Chainlink staleness + completed-round guard (`internal`, inlined into the router). |
| — | `interfaces/*.sol` (4) | 118 | `IReceiver`, `IPaymentLanes`, `ISessionGrant`, `IHouseTokenFactory`. |
| | **Total** | **1004** | |

---

## 2. Methodology

The contracts were assessed with four independent, overlapping techniques. The
governing rule for every static-tool result is the real-audit convention:
**resolve or justify — never silently suppress.**

1. **Foundry unit tests** — positive behaviour + every revert path for each
   contract (`test/unit/**`).
2. **Foundry invariant (fuzz) tests** — 9 money-path invariants under
   `fail_on_revert = true`, so a swallowed revert is a test failure
   (`test/invariant/**`). §5 lists each one and what it means.
3. **Foundry adversarial / red-team tests** — exploit-only suites that attempt
   the actual attack and assert it reverts (`test/attack/**`).
4. **Static analysis** — Aderyn v0.1.9 (`--no-snippets`) and Slither v0.11.5,
   both scoped to `src/`.
5. **`forge coverage`** — per-contract line/statement/branch/function coverage.
6. **Manual review** — CEI ordering, custody, oracle handling, access control,
   and the two real issues in §7.

### 2.1 Gate result (this commit)

| Step | Result |
| --- | --- |
| `forge build` | **green** (solc 0.8.28, `via_ir`, `cancun`) |
| `forge test` | **295 tests passed, 0 failed, 0 skipped** (20 suites) |
| `forge coverage` | **100% functions** on every contract; lines 99.74%, statements 99.15%, branches 95.56% overall |
| Invariants | **9 / 9 hold** under `fail_on_revert`, 0 reverts (64 runs x 4096 calls each) |
| Aderyn | 3 High + 9 Low — **all triaged** (false-positive / by-design / style) |
| Slither | 16 results across 10 detectors — **all triaged** |

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
business owner — Access0x1 has none. This is enforced by the
`invariant_zeroCustody` and `invariant_conservation*` fuzz invariants (§5).

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

| Contract | Unit | Attack | Invariant | Total tests | Lines | Statements | Branches | Functions |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| `Access0x1Router.sol` | 53 (+1 deploy) | 3 | 6 | 63 | 100% | 100% | 100% | 100% |
| `PaymentLanes.sol` | 37 | 41 (note 1) | 3 | 81 | 100% | 97.10% | 85.71% | 100% |
| `SessionGrant.sol` | 29 | 18 | — | 47 | 98.90% | 99.19% | 95.83% | 100% |
| `ChainRegistry.sol` | 21 (+1 deploy) | 8 | — | 30 | 100% | 100% | 100% | 100% |
| `Access0x1Receiver.sol` | 16 | 13 | — | 29 | 100% | 100% | 100% | 100% |
| `HouseToken` + `HouseTokenFactory` | 20 | — | — | 20 | 100% / 100% | 87.50% / 100% | 50% / 100% | 100% |
| `NameMath.sol` | 14 | — | — | 14 | 100% | 100% | 100% | 100% |
| `OracleLib.sol` | 5 | — | — | 5 | 100% | 100% | 100% | 100% |
| Cross-cutting (`DeployAll`) | 6 | — | — | 6 | — | — | — | — |
| **Total** | | | | **295** | **99.74%** | **99.15%** | **95.56%** | **100%** |

Note 1: PaymentLanes attack = `PaymentLanes.attack` (24) + `PaymentLanesFirewall.attack` (13) + `PaymentLanesFirewallInvariant.attack` (4).

The sub-100% rows are **unreachable defence-in-depth guards**, documented and
intentionally kept (covering them would require weakening the contract):

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

## 5. The 9 fuzz invariants

Run under `[invariant] fail_on_revert = true` (64 runs x 4096 calls each in the
default profile; 256 x 128 in CI). A revert is a real failure — handlers bound
their inputs and early-return on invalid preconditions.

**`Access0x1Router` (6):**

| Invariant | Meaning |
| --- | --- |
| `invariant_conservationNative` | For native pay: `net + platformFee + merchantFee == gross`, exactly — no wei created or lost. |
| `invariant_conservationToken` | The same conservation identity for ERC-20 pay legs. |
| `invariant_feeCap` | No payment is ever charged more than `MAX_FEE_BPS`. |
| `invariant_merchantIsolation` | A payment to one merchant never mutates another merchant's accounting. |
| `invariant_platformCutToTreasury` | The platform's cut always reaches the configured treasury — never a third party, never the router. |
| `invariant_zeroCustody` | The router holds no token balance between transactions (the core custody property). |

**`PaymentLanes` (3):**

| Invariant | Meaning |
| --- | --- |
| `invariant_conservationUsdc` | USDC lane: total credited == total claimable + total claimed; no value created. |
| `invariant_conservationEurc` | The same conservation for the EURC lane (cross-asset firewall: USDC never pays out as EURC). |
| `invariant_canaryLaneFrozen` | A deliberately frozen "canary" lane never accrues or releases value, proving the firewall isolates assets. |

All 9 held with **0 reverts**.

---

## 6. Findings

The full per-instance disposition lives in [`audit/FINDINGS.md`](FINDINGS.md).
Summary below. **Severity** is the analyser's claim; **Status** is the audited
disposition. None of these is an exploitable vulnerability in the deployed
configuration.

### 6.1 Aderyn — 3 High + 9 Low, all triaged

| ID | Title (Aderyn) | Severity | Status |
| --- | --- | --- | --- |
| H-1 | Arbitrary `from` in `transferFrom` (`Access0x1Router` `_pullExact`) | High | **False positive.** `from` is the payer threaded from the pay entrypoint (the address the router pulls the pay-in from), not an attacker-chosen third party with a standing approval. The balance-delta check also rejects fee-on-transfer skims. |
| H-2 | Uninitialized state variable (`HouseTokenFactory.deployedCount`) | High | **False positive (style).** `deployedCount` is a counter; Solidity zero-initialises it. No money path; an explicit `= 0` adds nothing. |
| H-3 | Unprotected native-ETH send (`Access0x1Router` `payNative` refund, `claimRescue`) | High | **By design.** Recipients are caller-configured (zero-checked) merchant/treasury/fee/buyer addresses or `msg.sender`; the contract is `nonReentrant` + CEI. A payments router sending native value is its purpose. |
| L-1 | Centralization risk (18x owner setters + pause) | Low | **By design (documented trust assumption, §3.3).** No owner path reaches merchant funds. |
| L-2 | Missing `address(0)` check (`setPaymentLanes`) | Low | **By design.** `address(0)` is the deliberate "disable lanes" sentinel (documented inline). |
| L-3 | `public` could be `external` (`Receiver.supportsInterface`, `HouseToken.decimals`) | Low | **False positive.** Both are `override`s of base interfaces that must stay `public`. |
| L-4 | Literals could be constants (router scaling, NameMath / SessionGrant offsets) | Low | **Idiomatic.** Decimal-scaling bases and signature byte offsets, not magic numbers. |
| L-5 | Events missing `indexed` fields (14x) | Low | **By design.** Indexing targets only fields indexers filter on; over-indexing wide audit events wastes gas. |
| L-6 | Large literal `FEE_DENOMINATOR = 10_000` | Low | **Intentional.** Reads as a basis-point denominator; underscore-grouped and named. |
| L-7 | Internal functions called once could be inlined (3x `NameMath`) | Low | **By design.** Named helpers keep the pure-SVG math readable; no gas/behaviour impact. |
| L-8 | Unused custom error (`ChainRegistry__ZeroAddress`) | Low | **By design.** Reserved shared error for consumers enforcing non-zero `usdc`/`router`; part of the published surface. |
| L-9 | Redundant statement (`SessionGrant` `ok;`) | Low | **By design.** Documents that the best-effort ERC-6492 prepare result is intentionally ignored (inline comment). |

### 6.2 Slither — 16 results across 10 detectors, all triaged

| Detector | Where | Status |
| --- | --- | --- |
| `reentrancy-no-eth` / `reentrancy-benign` / `reentrancy-events` | `SessionGrant.openSessionFor` (the ERC-6492 `factory.call` before the nonce write); router benign post-call writes | **Justified — non-exploitable, guarded at runtime.** The 6492 prepare reentrancy is real; the `NonceMismatch` guard (§7.1) pins each authorisation to its validated nonce so a re-entrant open can neither double-open nor advance the nonce twice. Router entry points are all `nonReentrant`; CEI holds. Slither cannot see the runtime guard — the property is proven by the attack test. |
| `unused-return` | router `quote`; `SessionGrant._validate1271OrEOA{,Calldata}` (`ECDSA.tryRecover`) | **False positive.** `quote` intentionally drops the feed tuple after the staleness guard; the validators use the recovered address + error, dropping only the unused tuple slot (canonical `tryRecover` usage). |
| `timestamp` | `OracleLib`; `SessionGrant.remaining/_open/spend` | **By design.** Comparing `block.timestamp` to a staleness window / session expiry IS the intended guard; minute-scale validator drift cannot defeat an hour-plus bound. |
| `assembly` | `Access0x1Receiver._decodeMetadata` | **By design.** Fixed-offset calldata slicing of the Keystone metadata layout, guarded by `require(metadata.length >= 62)`. No memory writes, no dynamic offsets. |
| `low-level-calls` | `SessionGrant._isValidSignatureNow` (6492 `factory.call`), `_validate1271OrEOA` (1271 `staticcall`) | **By design.** ERC-6492/ERC-1271 require exactly these calls; the 1271 path is a no-state `staticcall`, the 6492 prepare is best-effort behind the magic suffix. |
| `naming-convention` | `Receiver.i_forwarder`, `HouseToken._DECIMALS` | **By design.** `i_` immutable / `_` constant are the project (Cyfrin) conventions; documented in the storage-layout note. |
| `shadowing-local` | `ISessionGrant.remaining(bytes32)` return name | **False positive / cosmetic.** A named return matching the interface function name shadows no state or parent symbol. |
| `redundant-statements` | `SessionGrant` `ok;` | **By design.** Same as Aderyn L-9. |

---

## 7. Real issues found and fixed during the build

Two genuine defects were found by adversarial testing during the build and
fixed. Both have regression tests; no existing test was weakened.

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

---

## 8. Residual risk & mainnet readiness

This section is intentionally conservative.

- **Status at the event: testnet-only.** Contracts run on Arc / Base / zkSync
  **testnets** with the testnet USDC/EURC and testnet Chainlink feeds. No
  mainnet deployment ships at the event.
- **This is not a third-party audit.** It is an internal engineering audit
  backed by 295 tests, 9 invariants, and two static analysers. Strong coverage
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

*Generated as part of the Access0x1 build (ETHGlobal NY 2026). Analyser
versions: Aderyn v0.1.9, Slither v0.11.5, Foundry solc 0.8.28 / EVM cancun.
The raw Aderyn `report.md` is gitignored; `audit/FINDINGS.md` is the curated
per-instance record.*
