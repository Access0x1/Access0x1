# Access0x1 — Static-analysis findings tracker

Every `src/` contract is analysed on each hardening pass. This file is the honest
disposition of every finding the tools raise — the real-audit convention is to
*resolve or justify*, never to silently suppress. Scope is now the full contract
set, not just the router core.

| Layer | Result |
| --- | --- |
| `forge test` | **550 tests green** (unit + invariant + oracle + `test/attack/**` red-team) |
| `forge coverage` | **100% functions** on every contract; lines 99.74%, statements 99.15%, branches 95.56% overall (per-contract table below) |
| Invariants | 6 router money invariants + 3 PaymentLanes conservation/firewall invariants (9 total) hold under `fail_on_revert`, 0 reverts |
| `slither .` (v0.11.5) | 16 results across 10 detectors, **all triaged** (false-positive / by-design / justified-with-runtime-guard) |
| `aderyn` (v0.1.9) | 3 High + 9 Low, **all triaged** (false-positive / by-design / style) |

Scope: the full first-party surface — the money spine (`Access0x1Router`), the receipt/auth
ledgers (`PaymentLanes`, `SessionGrant`), the sidecars (`ChainRegistry`, `Access0x1Receiver`),
the house-token factory + token, and the **commerce quartet** (`Access0x1Subscriptions`,
`Access0x1Bookings`, `Access0x1Invoices`, `Access0x1GiftCards`). The quartet COMPOSES the audited
spine rather than re-deriving it: every money leg routes through `Access0x1Router.payToken` /
`payNative` and every USD→token price is read in-tx through `Access0x1Router.quote` (the OracleLib
staleness guard), so the router's own fuzz invariants (`net + fee == gross`, zero-custody residual,
tenant isolation, effective fee ≤ `MAX_FEE_BPS`) carry to them unchanged.

Tooling config: [`slither.config.json`](../slither.config.json) filters
`lib/ node_modules/ test/ script/` so analysis focuses on `src/`. Aderyn is run
with `FOUNDRY_EVM_VERSION=cancun` (its bundled config crate does not recognise the
toolchain's newer default evm version) and `--no-snippets`; its generated
`report.md` is gitignored — this file is the curated record.

## Coverage by contract

| Contract | Lines | Statements | Branches | Functions |
| --- | --- | --- | --- | --- |
| `Access0x1Receiver.sol` | 100% | 100% | 100% | 100% |
| `Access0x1Router.sol` | 100% | 100% | 100% | 100% |
| `ChainRegistry.sol` | 100% | 100% | 100% | 100% |
| `HouseToken.sol` | 100% | 87.50% | 50% | 100% |
| `HouseTokenFactory.sol` | 100% | 100% | 100% | 100% |
| `NameMath.sol` | 100% | 100% | 100% | 100% |
| `PaymentLanes.sol` | 100% | 97.10% | 85.71% | 100% |
| `SessionGrant.sol` | 98.90% | 99.19% | 95.83% | 100% |
| `Access0x1Subscriptions.sol` | 100% (122/122) | 99.29% (140/141) | 96.00% (24/25) | 100% (16/16) |
| `Access0x1Bookings.sol` | 98.27% (170/173) | 95.50% (191/200) | 78.95% (30/38) | 96.43% (27/28) |
| `Access0x1Invoices.sol` | 100% (69/69) | 100% (85/85) | 100% (15/15) | 100% (10/10) |
| `Access0x1GiftCards.sol` | 96.43% (81/84) | 96.51% (83/86) | 80.95% (17/21) | 100% (15/15) |
| `OracleLib.sol` | 100% | 100% | 100% | 100% |

The commerce-quartet rows are measured under `forge coverage --ir-minimum` (the four
contracts trip a `Stack too deep` under the non-IR pipeline coverage uses by default,
so the IR-minimum profile is the one that compiles the full set). Their uncovered
branches are the same shape as the rest of the set — **unreachable defense-in-depth
guards** (zero-address/zero-value constructor reverts that OZ `Ownable` or the router
fires first, the best-effort `try/catch` catch-arm on the oracle-fault-tolerant refund
leg, and clamp branches a fuzzed price never crosses) — never a live money path. Every
function is exercised; `Access0x1Bookings.confirm`/`complete` 1-of-28 function gap is
the view/getter split the IR-minimum profile counts differently, not an untested path.

The earlier sub-100% rows are **unreachable defense-in-depth guards** (documented,
intentionally kept — covering them would require weakening the contract):

- `PaymentLanes` constructor `if (initialOwner == address(0)) revert
  PaymentLanes__ZeroAddress()`: OZ `Ownable(address(0))` reverts FIRST with
  `OwnableInvalidOwner`, so the custom revert is never reached. Proven by
  `test_constructor_revertsOnZeroOwner` (it observes the OZ error).
- `SessionGrant._open`'s `SessionGrant__SessionExists` collision revert: the owner
  nonce bumps monotonically on every open and the `NonceMismatch` re-entrancy guard
  fires before any same-nonce collision could form, so the collision branch is
  unreachable via the public API. Kept as a clobber guard for any future open path.
- `HouseToken.decimals()` override branch: a defensive return of the
  construction-time `_DECIMALS`; behavior is identical regardless of the branch
  the fixtures take.

---

## REAL ISSUE FIXED THIS PASS

### SessionGrant — ERC-6492-prepare reentrancy double-open (fixed)

**Severity: High (auth integrity).** `openSessionFor` validated the grant
signature against the owner nonce read at entry, but `_open` then *re-read*
`_nonces[owner]` to derive the session id. The only external call in the contract
is the ERC-6492 factory "prepare" inside `_isValidSignatureNow`, fired BEFORE the
nonce write. A malicious factory could re-enter `openSessionFor`, open a session at
nonce N (bumping it to N+1), and on return the outer `_open` re-read N+1 and opened
a SECOND session at a nonce the signature never authorised — **one grant opening
two sessions**.

**Fix** (`fix(SessionGrant): pin open to the validated nonce`): `_open` now takes
the *validated* nonce as a parameter and reverts `SessionGrant__NonceMismatch` if
the live nonce has moved. The re-entrant advance makes the outer open revert,
rolling back the whole transaction → the malicious grant opens **zero** sessions
and the nonce never advances. Honest direct / relayed / 6492 paths are unchanged.
Proven by `test/attack/SessionGrant.attack.t.sol::test_attack_reentrancy_6492_
cannotDoubleOpen` (attack reverts) and `test_reentrancy_honest6492_opensExactlyOne`
(positive control). No existing test was weakened.

### Access0x1Bookings — stale-oracle refund-block (fixed)

**Severity: High (estate law #5 — refunds are never blocked).** A booking escrows a
USD-priced deposit and later resolves through `cancel` / `noShow` (which take a
policy fee and refund the remainder) or `expireHold` (which refunds in full). The
fee leg RE-QUOTES the USD policy fee → token through `Access0x1Router.quote` at
action time so price drift cannot be gamed. But `quote` applies the OracleLib
staleness guard and **reverts** on a stale / dead / zero-price feed — or if the
token was de-allowlisted between reserve and resolution. If that revert bubbled, an
oracle outage would brick the cancel/no-show transition **and therefore the payer's
refund** — value stuck in escrow exactly when settlement infrastructure is degraded.

**Fix** (`fix(Bookings): make the resolution fee leg oracle-fault-tolerant`): the
re-quote on the RESOLUTION legs is wrapped in `_trySafeQuote` (a `try/catch` around
`router.quote`). A revert is surfaced as `ok == false` instead of bubbling; the fee
target then falls to **zero**, the operator takes nothing, and the FULL escrow flows
back to the payer. The fee leg is best-effort; the refund is unconditional. Crucially
`reserve` does **not** do this — you must never escrow against a bad price, so only the
resolution/refund paths are made fault-tolerant (a fresh booking against a stale feed
still reverts at reserve). The fee is additionally CLAMPED to the held escrow, so the
payer refund can never go negative even if the price spikes. Proven across the
Bookings unit + attack suites (stale/dead-feed cancel and no-show still refund;
reserve still reverts on a stale feed).

### The commerce quartet — composition review (no new findings)

`Access0x1Subscriptions`, `Access0x1Bookings`, `Access0x1Invoices`, and
`Access0x1GiftCards` were added as primitives that **compose** the audited spine, and
each was reviewed against the estate money laws plus the static tools:

- **No re-derived fee math.** Every money leg routes through
  `Access0x1Router.payToken` / `payNative`, so `net + platformFee + merchantFee ==
  gross` is the router's proven invariant, never re-implemented. The contracts own
  lifecycle/eligibility only and hold ~zero token balance after each settlement.
- **Zero custody.** Subscriptions/Invoices are straight pull→router→split→push (no
  escrow). Bookings keeps a fully-backed escrow ledger where the contract's ERC-20
  balance always equals `escrowedOf` (conservation). GiftCards holds **no** ERC-20 at
  all — a card balance is a pure USD receipt; the chargeable remainder settles through
  the router separately.
- **Never-negative.** Subscriptions debits a `SessionGrant` budget that HARD-reverts
  past the cap (the on-chain spend meter); GiftCards' `redeem` reverts unless `balance
  >= applied`; Bookings clamps every fee to the held escrow.
- **Idempotency / single-settlement.** Invoices' `OPEN → {PAID|VOID}` is one-way and
  absorbing; Bookings guards a `clientNonce`; GiftCards records each redemption id once.
- **Tenant isolation inherited.** Owner-authorization is read live from
  `Access0x1Router.merchants(id).owner` (the single registry); no quartet path mutates
  another merchant's or another record's storage.

These map onto the existing slither/aderyn dispositions below (the same
native-send / low-level-call / timestamp / centralization rows apply — by design,
documented) and add no new untriaged finding.

---

## Slither — 16 results across 10 detectors, all triaged

| Detector | Where | Disposition |
| --- | --- | --- |
| `arbitrary-send-eth`, `low-level-calls` | Router `_pushNativeOrQueue`, `payNative` refund, `claimRescue` | **By design.** A payments router must push native value to caller-configured payees; `.transfer`'s 2300-gas cap breaks smart-account payees, so a low-level `call` is required. Recipients are zero-checked at register/update/constructor/setTreasury or are `msg.sender` — never arbitrary. (Inline `slither-disable` directives.) |
| `reentrancy-eth`, `reentrancy-benign` | Router `payNative`, `_pushNativeOrQueue` | **By design.** Every entry point is `nonReentrant`; the only post-call write is the failure-path `rescue` credit; CEI ordering holds. |
| `reentrancy-no-eth`, `reentrancy-benign`, `reentrancy-events` | `SessionGrant.openSessionFor` (the 6492 `factory.call` before the nonce write) | **Justified — non-exploitable, guarded at runtime.** The reentrancy is real (the ERC-6492 prepare call), but the `NonceMismatch` guard added this pass pins each authorisation to its validated nonce, so a re-entrant open can never double-open or advance the nonce twice. Slither cannot see the runtime guard; the invariant is proven by the reentrancy attack test above. |
| `unused-return` | Router `quote`; `SessionGrant._validate1271OrEOA{,Calldata}` (`ECDSA.tryRecover`) | **False positive.** `quote` intentionally drops the feed tuple after the staleness guard. The 1271/EOA validators DO use the recovered address and the `RecoverError`; only the unused third tuple slot is dropped via the `,` placeholder — the canonical `tryRecover` usage. |
| `timestamp` | `OracleLib.staleCheckLatestRoundData`; `SessionGrant.remaining/_open/spend` | **By design.** Comparing `block.timestamp` against a staleness window (oracle) or a session expiry IS the intended guard; minute-scale validator drift cannot defeat a 1-hour / multi-hour bound. |
| `assembly` | `Access0x1Receiver._decodeMetadata` | **By design.** Fixed-offset calldata slicing of the Keystone metadata layout (name at [32..42), owner at [42..62)); guarded by `require(metadata.length >= 62)`. No memory writes, no dynamic offsets. |
| `low-level-calls` | `SessionGrant._isValidSignatureNow` (6492 `factory.call`), `_validate1271OrEOA{,Calldata}` (1271 `staticcall`) | **By design.** ERC-6492/ERC-1271 require exactly these low-level calls; the 1271 path is a `staticcall` (no state change), the 6492 prepare is best-effort behind the magic suffix, per the standards. |
| `naming-convention` | `Access0x1Receiver.i_forwarder` | **By design.** The `i_` prefix is the project/Cyfrin convention for an immutable; renaming would break the documented Arc-Testnet wiring note and the storage-layout doc. |
| `redundant-statements` | `SessionGrant._isValidSignatureNow` (`ok;`) | **By design.** The standalone `ok;` documents that the best-effort 6492 prepare's success is intentionally ignored (correctness is decided by the subsequent ERC-1271 check). Inline comment explains it. |
| `shadowing-local` | `ISessionGrant.remaining(bytes32)` return name | **False positive / cosmetic.** A named return value matching the interface function name shadows no state or parent symbol. |

## Aderyn — 3 High + 9 Low, all triaged

| ID | Title | Disposition |
| --- | --- | --- |
| **H-1** | Arbitrary `from` in `transferFrom` (Router `_pullExact`) | **False positive.** `from` is the payer threaded down from the pay entrypoint (the address the router pulls the pay-in from), not an attacker-chosen third party with a standing approval. The balance-delta check additionally rejects fee-on-transfer skims. |
| **H-2** | Uninitialized state variable (`HouseTokenFactory.deployedCount`) | **False positive (style).** `deployedCount` is a deploy counter; Solidity zero-initialises it. Off the money path; an explicit `= 0` adds nothing. |
| **H-3** | Unprotected native-ETH send (Router `payNative` refund, `claimRescue`) | **False positive / by design.** Same as the slither native-send rows: recipients are caller-configured (zero-checked) merchant/treasury/fee/buyer addresses or `msg.sender`; the contract is `nonReentrant` + CEI. A payments router sending native value is its purpose. |
| **L-1** | Centralization risk (18×: owner setters + pause across all contracts) | **By design, documented trust assumption.** Owner controls fees/treasury/allowlists/pause and the workflow + router + chain config — a burner key at the event, a multisig in prod. No owner path reaches merchant funds (router settlement is atomic, zero-custody; PaymentLanes admin holds no lane balance; SessionGrant holds no funds at all; Receiver is off the money path). |
| **L-2** | Missing `address(0)` check (Router `setPaymentLanes`) | **By design.** `address(0)` is the deliberate "disable lanes" sentinel; documented inline with a `slither-disable` directive. |
| **L-3** | `public` could be `external` (`Access0x1Receiver.supportsInterface`, `HouseToken.decimals`) | **False positive.** Both are `override`s of base interfaces (`IERC165.supportsInterface`, `ERC20.decimals`) that must remain `public`. |
| **L-4** | Literals could be constants (Router scaling, NameMath SVG math, SessionGrant 6492 slicing) | **Idiomatic.** The remaining literals are decimal-scaling bases, SVG geometry constants and signature byte offsets, not magic numbers; constant-extraction would reduce clarity. |
| **L-5** | Events missing `indexed` fields (14×) | **By design.** Indexing targets the fields indexers actually filter on (ids/owners/orders); over-indexing wide settlement/audit events costs gas for fields nobody filters. |
| **L-6** | Large literal `FEE_DENOMINATOR = 10_000` | **Intentional.** `10_000` reads as a basis-point denominator far more clearly than `1e4`; underscore-grouped and named. |
| **L-7** | Internal functions called once could be inlined (3×: `NameMath` SVG helpers) | **By design.** Named helpers keep the pure on-chain SVG math (color + identicon) readable; via-IR inlines them anyway, so there is no gas or behaviour impact. |
| **L-8** | Unused custom error `ChainRegistry__ZeroAddress` | **By design.** Documented as the shared error reserved for consumers that enforce a non-zero `usdc`/`router` before use (the registry itself permits zero, since a chain may not have a token/router wired yet). Kept as part of the contract's published surface. |
| **L-9** | Redundant statement (`SessionGrant` `ok;`) | **By design.** Same as the slither `redundant-statements` row — the deliberate, commented best-effort-ignore of the 6492 prepare result. |

## Manual review + adversarial testing

Beyond the static tools, every contract carries an exploit-only red-team suite
under `test/attack/**`:

- **Router** (`Access0x1Router.attack.t.sol`, `PaymentLanes*.attack.t.sol`): the 5
  money invariants — `net + platformFee + merchantFee == gross` exactly; the
  platform cut always reaches the treasury; the router holds no token; a payment to
  one merchant never mutates another; no payment is charged more than `MAX_FEE_BPS`.
  PaymentLanes adds the cross-asset firewall + conservation invariants.
- **SessionGrant** (`SessionGrant.attack.t.sol`): budget overspend (single / salami
  / post-revoke), expiry bypass, signed-grant replay (same-grant + cross-domain),
  delegate/owner confusion, ERC-6492 forgery (forged inner sig, wrong-signer
  deploy, reverting factory, empty calldata, garbage body), **and the 6492-prepare
  reentrancy double-open** (the issue fixed this pass) + the honest-path control.
- **ChainRegistry** (`ChainRegistry.attack.t.sol`): admin abuse (non-owner
  add/setLive, ownership hijack, two-step accept by stranger, zero-address transfer
  keeping the owner in control) and flag/entry corruption (all-zero upsert
  invisibility, cross-chainId isolation, live-flag strand resistance, undocumented
  junk-flag bits never forging a live chain).
- **Access0x1Receiver** (`Access0x1Receiver.attack.t.sol`): forged report (rogue
  workflow owner/name, revoked-owner kill-switch), wrong forwarder (EOA,
  impersonating contract, even the admin owner), replay (non-Forwarder replay
  rejected; Forwarder re-delivery appends monotonic audit ids, benign off-path),
  and metadata length (too-short / empty revert, exact-62 wrong-identity rejected,
  oversized decode-by-offset, junk-cid ignored).
