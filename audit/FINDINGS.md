# Access0x1 — Static-analysis findings tracker

Every `src/` contract is analysed on each hardening pass. This file is the honest
disposition of every finding the tools raise — the real-audit convention is to
*resolve or justify*, never to silently suppress. Scope is now the full contract
set, not just the router core.

| Layer | Result |
| --- | --- |
| `forge test` | **871 tests green, 0 failed, 0 skipped** (86 suites: unit + attack + invariant + integration + fuzz; **fork-excluded** — the 3 Chainlink fork tests pass in isolation, flaky only under live-RPC rate-limit) |
| `forge coverage` | lines **98.58%**, statements **97.65%**, branches **89.90%**, functions **100%** overall (`--ir-minimum`; per-contract table below, raw in [`COVERAGE.md`](COVERAGE.md)) |
| Invariants | **31 total** hold under `fail_on_revert`, 0 reverts: 6 router + 3 PaymentLanes + 6 Bookings + 6 Invoices + 6 Subscriptions + 4 GiftCards |
| `slither .` (v0.11.5) | **34 results across 13 detectors**, all triaged (false-positive / by-design / justified-with-runtime-guard); router native-send rows suppressed by inline `slither-disable` |
| `aderyn` (v0.1.9) | **4 High + 11 Low**, all triaged (false-positive / by-design / style) |

Scope: the full first-party surface — the money spine (`Access0x1Router`), the receipt/auth
ledgers (`PaymentLanes`, `SessionGrant`), the sidecars (`ChainRegistry`, `Access0x1Receiver`),
the house-token factory + token, and the **commerce quintet** (`Access0x1Subscriptions`,
`Access0x1Bookings`, `Access0x1Invoices`, `Access0x1GiftCards`, `Access0x1Nft`). The quintet COMPOSES
the audited spine rather than re-deriving it: every money leg routes through `Access0x1Router.payToken` /
`payNative` and every USD→token price is read in-tx through `Access0x1Router.quote` (the OracleLib
staleness guard), so the router's own fuzz invariants (`net + fee == gross`, zero-custody residual,
tenant isolation, effective fee ≤ `MAX_FEE_BPS`) carry to them unchanged. `Access0x1Nft` is the
USD-priced, zero-custody NFT-commerce member (ERC-721 escrow + atomic settle-through-Router on `buy`).

Tooling config: [`slither.config.json`](../slither.config.json) filters
`lib/ node_modules/ test/ script/` so analysis focuses on `src/`. Aderyn is run
with `FOUNDRY_EVM_VERSION=cancun` (its bundled config crate does not recognise the
toolchain's newer default evm version) and `--no-snippets`; its generated
`report.md` is gitignored — this file is the curated record.

**Tool-honesty note (this re-run).** Both static analysers actually executed over
the full 13-contract surface. **Slither ran clean** (34 / 13). **Aderyn** requires a
checkout whose `node_modules`/`lib` resolve *inside* the project root — run from a
worktree with those paths symlinked out of the tree it panics with `StripPrefixError`
before emitting a report, so the Aderyn numbers here were produced from a checkout
with a local (non-symlinked) `node_modules`; Aderyn also prints a cosmetic
version-parse panic *after* writing the report (it cannot parse the `foundry-zksync`
version string) — the report itself is complete. `forge coverage` uses `--ir-minimum`
because the commerce quintet trips `Stack too deep` under the default coverage
pipeline.

## Coverage by contract

Measured under `forge coverage --ir-minimum` (the quintet trips `Stack too deep`
under the default coverage pipeline). Raw snapshot: [`COVERAGE.md`](COVERAGE.md).

| Contract | Lines | Statements | Branches | Functions |
| --- | --- | --- | --- | --- |
| `Access0x1Bookings.sol` | 99.42% (172/173) | 96.00% (192/200) | 78.95% (30/38) | 100% (28/28) |
| `Access0x1GiftCards.sol` | 96.43% (81/84) | 96.51% (83/86) | 80.95% (17/21) | 100% (15/15) |
| `Access0x1Invoices.sol` | 100% (69/69) | 100% (85/85) | 100% (15/15) | 100% (10/10) |
| `Access0x1Nft.sol` | 96.30% (52/54) | 94.83% (55/58) | 90.00% (9/10) | 100% (8/8) |
| `Access0x1Receiver.sol` | 92.00% (23/25) | 92.59% (25/27) | 66.67% (4/6) | 100% (6/6) |
| `Access0x1Router.sol` | 97.87% (138/141) | 98.14% (158/161) | 97.50% (39/40) | 100% (19/19) |
| `Access0x1Subscriptions.sol` | 100% (124/124) | 99.30% (142/143) | 96.00% (24/25) | 100% (16/16) |
| `ChainRegistry.sol` | 100% (17/17) | 100% (22/22) | 100% (4/4) | 100% (5/5) |
| `HouseToken.sol` | 100% (10/10) | 87.50% (7/8) | 50% (1/2) | 100% (3/3) |
| `HouseTokenFactory.sol` | 100% (11/11) | 100% (13/13) | 100% (2/2) | 100% (2/2) |
| `NameMath.sol` | 100% (40/40) | 100% (49/49) | 100% (3/3) | 100% (7/7) |
| `PaymentLanes.sol` | 100% (68/68) | 97.10% (67/69) | 85.71% (12/14) | 100% (16/16) |
| `SessionGrant.sol` | 97.80% (89/91) | 98.39% (122/124) | 95.83% (23/24) | 100% (16/16) |
| `libraries/OracleLib.sol` | 100% (9/9) | 100% (17/17) | 100% (4/4) | 100% (2/2) |
| **Total** | **98.58% (903/916)** | **97.65% (1037/1062)** | **89.90% (187/208)** | **100% (153/153)** |

The sub-100% rows are **unreachable defense-in-depth guards** (documented,
intentionally kept — covering them would require weakening the contract): the
best-effort `try/catch` catch-arms on Bookings' oracle-fault-tolerant resolution
legs (`_trySafeQuote`/`_payoutOrQueue` — the refund-never-blocked fallback), the
Router `_pushNativeOrQueue` rescue arm, the Receiver assembly-length pre-guard, the
`HouseToken.decimals()` override (both arms return the same value), and the
zero-owner / `SessionExists` clobber guards below. Every external entrypoint is
exercised by the unit + attack + invariant suites; **function coverage is now 100%
(153/153)** — the earlier 142/143 split-count gap closed as the suite grew.

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

**Severity: High (money-safety invariant #5 — refunds are never blocked).** A booking escrows a
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

### Access0x1Router — missing L2 sequencer-uptime check (added M-1)

**Severity: Medium (oracle integrity on L2).** `quote()` reads a Chainlink price
feed in the settlement tx (the OracleLib staleness guard). On an Arbitrum/Optimism/
Base-style L2 the feed is only as trustworthy as the sequencer that posts it: during a
sequencer outage the feed stops updating, and on restart the first prices can be stale
or manipulable. The staleness guard alone does not cover this — a feed can be "fresh"
by `updatedAt` yet sit behind a sequencer that just came back. The classic L2 oracle
pitfall (Chainlink's own guidance, and the Sherlock/Code4rena house rule) is to gate
the read on the **L2 Sequencer Uptime feed** before trusting any L2 price.

**Fix** (`feat(router): L2 sequencer-uptime guard on quote()`): `OracleLib` gains
`checkSequencerUp` — Chainlink's L2 Sequencer Uptime pattern: `answer == 0` ⇒ up,
`== 1` ⇒ `OracleLib__SequencerDown`; `startedAt == 0` (the uptime feed has posted no
round) ⇒ down; and the sequencer must have been continuously up past a 1-hour grace
window or the quote reverts `OracleLib__SequencerGracePeriodNotOver`. The router holds
an optional `sequencerUptimeFeed` (owner `setSequencerUptimeFeed` + event) and runs
the check in `quote()` **only when the feed is set**. With no feed configured — the
default, and L1 / Arc (no sequencer) — the check is skipped and behaviour is
byte-for-byte unchanged, so the router's existing money invariants and the full
pre-existing suite carry over untouched. The owner wires the per-L2 Chainlink uptime
feed at deploy time (addresses from docs.chain.link); L1 / Arc leave it unset. Proven
by `test/unit/SequencerGuard.t.sol` (9 tests: up-past-grace, explicit-up, down→revert,
within-grace→revert, exact-grace-boundary→revert, uninitialized `startedAt==0`→revert,
unset-feed-skips, owner-gated setter, set/clear). The guard adds no value path and no
custody surface — it can only *reject* a quote, never alter settlement math. (The
per-contract coverage table above is the last full `/audit` snapshot and predates this
guard; it refreshes — `OracleLib` gaining its second function, the router its storage/
event/setter — on the next coverage run.)

### The commerce quintet — composition review (no new findings)

`Access0x1Subscriptions`, `Access0x1Bookings`, `Access0x1Invoices`,
`Access0x1GiftCards`, and `Access0x1Nft` were added as primitives that **compose** the
audited spine, and each was reviewed against the estate money laws plus the static tools:

- **No re-derived fee math.** Every money leg routes through
  `Access0x1Router.payToken` / `payNative`, so `net + platformFee + merchantFee ==
  gross` is the router's proven invariant, never re-implemented. The contracts own
  lifecycle/eligibility only and hold ~zero token balance after each settlement.
- **Zero custody.** Subscriptions/Invoices are straight pull→router→split→push (no
  escrow). Bookings keeps a fully-backed escrow ledger where the contract's ERC-20
  balance always equals `escrowedOf` (conservation). GiftCards holds **no** ERC-20 at
  all — a card balance is a pure USD receipt; the chargeable remainder settles through
  the router separately. `Access0x1Nft` holds **no** payment token — `buy` pulls the
  quoted gross from the buyer and forwards it to the Router in the same call, then resets
  the approval to 0; the only thing it escrows is the listed ERC-721, between `list` and
  `buy`/`cancelListing`.
- **Never-negative.** Subscriptions debits a `SessionGrant` budget that HARD-reverts
  past the cap (the on-chain spend meter); GiftCards' `redeem` reverts unless `balance
  >= applied`; Bookings clamps every fee to the held escrow.
- **Idempotency / single-settlement.** Invoices' `OPEN → {PAID|VOID}` is one-way and
  absorbing; Bookings guards a `clientNonce`; GiftCards records each redemption id once;
  `Access0x1Nft` flips a listing's `active` to false (effect) BEFORE the settle/transfer
  interactions, so a re-entrant `buy`/`cancelListing` finds it inactive — one-shot sale.
- **CEI + `nonReentrant` on every mutating path.** `Access0x1Nft.{list,buy,cancelListing}`
  are each `nonReentrant` with checks→effects→interactions; the NFT legs use
  `safeTransferFrom` (a contract buyer that cannot receive ERC-721 reverts the whole
  atomic purchase, rolling the payment back), and `list` verifies `ownerOf == this` after
  escrow so a non-standard 721 cannot back a phantom listing.
- **Refund-never-blocked, asset side.** `Access0x1Nft.cancelListing` is **not** gated by
  `pause` — a seller can always retrieve an unsold NFT, the ERC-721 analogue of money-safety invariant
  #5 (no hostage assets).
- **Front-run / price-bump guard.** `Access0x1Nft.buy(listingId, maxPriceUsd8)` reverts
  unless the buyer-supplied USD price equals the listing's — explicit buyer consent to the
  exact price, defeating a seller bump or a swapped listing between quote and submit.
- **Tenant isolation inherited.** Owner-authorization is read live from
  `Access0x1Router.merchants(id).owner` (the single registry); no quintet path mutates
  another merchant's or another record's storage.

These map onto the existing slither/aderyn dispositions below (the same
native-send / low-level-call / timestamp / centralization / unused-return rows apply — by
design, documented) and add no new untriaged finding. `Access0x1Nft` is exercised at
**96.30% lines (52/54), 90% branches, 100% functions** by its 12 unit + 4 attack tests.

---

## Slither — 34 results across 13 detectors, all triaged

Slither v0.11.5 found **34 results across 13 detectors** over the 13-contract
surface. The router's `arbitrary-send-eth` and `reentrancy-eth` rows are NOT among
the 34 — they are suppressed at source by 17 inline `slither-disable` directives
(the by-design native-send paths); that suppression is disclosed in the first row
below rather than hidden. The three rows added since the previous (31-result) snapshot
are the two `Access0x1Nft` `unused-return` rows and the `missing-zero-check` on the
router's new `setSequencerUptimeFeed` (the audit M-1 L2-sequencer guard) — all by design,
disposed below.

| Detector | Where | Disposition |
| --- | --- | --- |
| `arbitrary-send-eth`, `reentrancy-eth` *(suppressed inline)* | Router `_pushNativeOrQueue`, `payNative` refund, `claimRescue` | **By design — suppressed by inline `slither-disable`.** A payments router must push native value to caller-configured payees; `.transfer`'s 2300-gas cap breaks smart-account payees, so a low-level `call` is required. Recipients are zero-checked at register/update/constructor/setTreasury or are `msg.sender` — never arbitrary. Every entry point is `nonReentrant`; the only post-call write is the failure-path `rescue` credit; CEI holds. |
| `incorrect-equality` | `Access0x1Bookings._payoutOrQueue` (`amount == 0`) | **False positive.** A strict `== 0` early-return on an exact internal value, not a balance/timestamp comparison; nothing external influences `amount`. |
| `reentrancy-no-eth`, `reentrancy-benign`, `reentrancy-events` | `SessionGrant.openSessionFor` (the 6492 `factory.call` before the nonce write); `Access0x1Bookings._payoutOrQueue` (rescue credit after the best-effort `transfer`) | **Justified — non-exploitable, guarded at runtime.** For SessionGrant the reentrancy is real (the ERC-6492 prepare call), but the `NonceMismatch` guard pins each authorisation to its validated nonce, so a re-entrant open can never double-open or advance the nonce twice (proven by the reentrancy attack test below). For Bookings the post-call write is the fail-soft rescue credit on a rejecting payee; the function is `nonReentrant` and the credit only grows a per-(payee,token) escrowed balance. Slither cannot see the runtime guards. |
| `uninitialized-local` | Router `quote` (`feedDecimals`/`tokenDecimals`); `Access0x1Bookings._cancel` (`feeTarget`) | **False positive.** Each is assigned on every reachable path before use — the decimals are read from the feed/token, `feeTarget` is set from the `_trySafeQuote` result (defaulting to zero on a fault, intentionally). |
| `unused-return` | `Access0x1Bookings/Invoices/GiftCards._merchantOwner` + `Access0x1Nft._requireMerchantOwner` (`router.merchants(...)`); `Access0x1Nft.list` (the `router.quote` allowlist/price probe); `SessionGrant._validate1271OrEOA{,Calldata}` (`ECDSA.tryRecover`) | **False positive.** The quintet helpers read only the merchant struct's `owner` field for an authorization check; `Access0x1Nft.list` calls `router.quote` purely to fail-fast on an unpriceable/disallowed token (the returned gross is re-quoted at `buy` time, never needed at list time); the validators use the recovered address + the `RecoverError`, dropping only the unused tuple slot via the `,` placeholder — canonical `tryRecover` usage. |
| `missing-zero-check` | Router `setSequencerUptimeFeed(feed)` | **By design.** `feed == address(0)` is the deliberate "no L2 sequencer feed — skip the check" sentinel (L1 / Arc, and the default), exactly mirroring `setPaymentLanes`' `address(0)`-disables sentinel; documented inline. |
| `shadowing-local` | `IAccess0x1GiftCards` params `cardId` vs the `cardId(...)` view; `ISessionGrant.remaining(bytes32)` return name | **False positive / cosmetic.** A parameter or named return matching an interface function name shadows no state or parent symbol — an interface-declaration artifact. |
| `timestamp` | `OracleLib.staleCheckLatestRoundData`; `SessionGrant.remaining/_open/spend`; `Access0x1Bookings.expireHold/cancelWithSession/_cancel` | **By design.** Comparing `block.timestamp` against a staleness window (oracle) / session expiry / booking cancel-window IS the intended guard; minute-scale validator drift cannot defeat the hour-plus / slot-scale bounds. |
| `assembly` | `Access0x1Receiver._decodeMetadata` | **By design.** Fixed-offset calldata slicing of the Keystone metadata layout (name at [32..42), owner at [42..62)); guarded by `require(metadata.length >= 62)`. No memory writes, no dynamic offsets. |
| `low-level-calls` | `SessionGrant._isValidSignatureNow` (6492 `factory.call`), `_validate1271OrEOA{,Calldata}` (1271 `staticcall`) | **By design.** ERC-6492/ERC-1271 require exactly these low-level calls; the 1271 path is a `staticcall` (no state change), the 6492 prepare is best-effort behind the magic suffix, per the standards. |
| `naming-convention` | `Access0x1Receiver.i_forwarder`, `HouseToken._DECIMALS` | **By design.** The `i_` immutable / `_` constant prefixes are the project/Cyfrin conventions; renaming would break the documented wiring + storage-layout notes. |
| `redundant-statements` | `SessionGrant._isValidSignatureNow` (`ok;`) | **By design.** The standalone `ok;` documents that the best-effort 6492 prepare's success is intentionally ignored (correctness is decided by the subsequent ERC-1271 check). Inline comment explains it. |

## Aderyn — 4 High + 11 Low, all triaged

Aderyn v0.1.9 ran clean over all 22 `src/` files (2293 nSLOC). The **category counts
are unchanged (4H / 11L)**; bringing `Access0x1Nft` and the router's M-1 sequencer
guard into scope only added *instances* of existing rows (H-4 +1, L-1 +4, L-3 +1,
L-6 +1) — dispositions are unchanged in kind.

| ID | Title | Inst. | Disposition |
| --- | --- | --- | --- |
| **H-1** | Arbitrary `from` in `transferFrom`/`safeTransferFrom` (Router `_pullExact`, Invoices `_pullExact`, Subscriptions charge) | 3 | **False positive.** In each case `from`/`subscriber` is the payer threaded from the pay entrypoint (the address the contract pulls the pay-in from), not an attacker-chosen third party with a standing approval. Each pull is followed by a balance-delta check that rejects fee-on-transfer skims. |
| **H-2** | Uninitialized state variable (`HouseTokenFactory.deployedCount`) | 1 | **False positive (style).** `deployedCount` is a deploy counter; Solidity zero-initialises it. Off the money path; an explicit `= 0` adds nothing. |
| **H-3** | Unprotected native-ETH send (Router `payNative` refund, `claimRescue`) | 2 | **False positive / by design.** Same as the slither native-send rows: recipients are caller-configured (zero-checked) merchant/treasury/fee/buyer addresses or `msg.sender`; the contract is `nonReentrant` + CEI. A payments router sending native value is its purpose. |
| **H-4** | Unused return value (`Access0x1Subscriptions._charge` return; `sessionGrant.spend` return; `Access0x1Nft.list`'s `router.quote` probe) | 3 | **False positive / benign.** `_charge` returns `gross` for the caller that needs it; the trial-skip path and the budget-meter call deliberately ignore the informational return; `Access0x1Nft.list` calls `router.quote` only to fail-fast on an unpriceable token (re-quoted at `buy`). The state effect (the spend) is never dropped. |
| **L-1** | Centralization risk (owner setters + pause across all contracts, incl. `Access0x1Nft` owner+pause/unpause and the router's `setSequencerUptimeFeed`) | 26 | **By design, documented trust assumption.** Owner controls fees/treasury/allowlists/pause and the workflow + router + chain config (now including the L2 sequencer-feed setter and the Nft pause) — a burner key at the event, a multisig in prod. No owner path reaches merchant funds (router settlement is atomic, zero-custody; `Access0x1Nft` never holds the payment token and its `cancelListing` is un-pausable so an unsold NFT is never hostage; PaymentLanes admin holds no lane balance; SessionGrant holds no funds at all; Receiver is off the money path). |
| **L-2** | Unsafe ERC20 operation (`Access0x1Bookings._payoutOrQueue` raw `.transfer`) | 1 | **By design — the refund-never-blocked mechanism.** The raw `.transfer` is wrapped in `try/catch`: a rejecting payee credits `_refundRescue` instead of bubbling. SafeERC20 would *revert* on a hostile token and brick the refund — the opposite of money-safety invariant #5. Inline-disabled. |
| **L-3** | Missing `address(0)` check (Router `setPaymentLanes`, `setSequencerUptimeFeed`) | 2 | **By design.** In both, `address(0)` is a deliberate "disable" sentinel — no payment lanes, and no L2 sequencer feed (L1 / Arc) — documented inline with a `slither-disable` directive. |
| **L-4** | `public` could be `external` (`Access0x1Receiver.supportsInterface`, `HouseToken.decimals`) | 2 | **False positive.** Both are `override`s of base interfaces (`IERC165.supportsInterface`, `ERC20.decimals`) that must remain `public`. |
| **L-5** | Literals could be constants (Router scaling, NameMath SVG math, SessionGrant 6492 slicing, Bookings scaling) | 15 | **Idiomatic.** The remaining literals are decimal-scaling bases, SVG geometry constants and signature byte offsets, not magic numbers; constant-extraction would reduce clarity. |
| **L-6** | Events missing `indexed` fields (incl. `Access0x1Nft.Cancelled`) | 26 | **By design.** Indexing targets the fields indexers actually filter on (ids/owners/orders); over-indexing wide settlement/audit events costs gas for fields nobody filters. |
| **L-7** | Modifier invoked only once (`Access0x1Subscriptions`) | 1 | **By design.** The named modifier documents the merchant-owner authorization gate; inlining hurts readability with no gas/behaviour impact. |
| **L-8** | Large literal `FEE_DENOMINATOR = 10_000` | 1 | **Intentional.** `10_000` reads as a basis-point denominator far more clearly than `1e4`; underscore-grouped and named. |
| **L-9** | Internal functions called once could be inlined (3×: `NameMath` SVG helpers) | 3 | **By design.** Named helpers keep the pure on-chain SVG math (color + identicon) readable; via-IR inlines them anyway, so there is no gas or behaviour impact. |
| **L-10** | Unused custom error `ChainRegistry__ZeroAddress` | 1 | **By design.** Documented as the shared error reserved for consumers that enforce a non-zero `usdc`/`router` before use (the registry itself permits zero, since a chain may not have a token/router wired yet). Kept as part of the contract's published surface. |
| **L-11** | Redundant statement (`SessionGrant` `ok;`) | 1 | **By design.** Same as the slither `redundant-statements` row — the deliberate, commented best-effort-ignore of the 6492 prepare result. |

## Manual review + adversarial testing

Beyond the static tools, every contract carries an exploit-only red-team suite
under `test/attack/**`:

- **Router** (`Access0x1Router.attack.t.sol`, `PaymentLanes*.attack.t.sol`): the 6
  money invariants — `net + platformFee + merchantFee == gross` exactly for native
  (`invariant_conservationNative`) and for token (`invariant_conservationToken`); the
  platform cut always reaches the treasury (`invariant_platformCutToTreasury`); the
  router holds no token (`invariant_zeroCustody`); a payment to one merchant never
  mutates another (`invariant_merchantIsolation`); no payment is charged more than
  `MAX_FEE_BPS` (`invariant_feeCap`). PaymentLanes adds the cross-asset firewall +
  conservation invariants.
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
- **Access0x1Subscriptions** (`Access0x1Subscriptions.attack.t.sol`,
  `Access0x1SubscriptionsRedTeam.attack.t.sol`): budget-ceiling exactness, renew past
  budget hard-stopped, double-renew-same-period reverts, revoked/foreign session
  cannot subscribe or renew, reentrant token-on-pull blocked, foreign-merchant plan
  cannot be edited, `renewX` never mutates `renewY`.
- **Access0x1Bookings** (`Access0x1Bookings.attack.t.sol`,
  `Access0x1BookingsRoundTrip.attack.t.sol`): **the stale-oracle refund-block fix**
  (stale/dead-feed cancel + no-show still refund; complete-deposit not stranded;
  reserve still reverts on a stale feed), late fee never exceeds escrow, blocked-refund
  cannot brick cancel, double-claim-refund reverts, reentrant refund-push cannot
  over-refund, settling booking A does not touch B's escrow, round-trip never
  over-pulls.
- **Access0x1Invoices** (`Access0x1Invoices.attack.t.sol`,
  `Access0x1Invoices.redteam.t.sol`): settle-at-most-once, cannot pay a void / void a
  paid invoice, locked-payer cannot be bypassed, reentrant native double-settle
  reverts, token replay cannot double-charge, stale price blocks settlement.
- **Access0x1GiftCards** (`Access0x1GiftCards.attack.t.sol`,
  `Access0x1GiftCardsRedTeam.attack.t.sol`): redeem never goes negative, redeem replay
  blocked, reversal cannot double-credit, coupon cap cannot be exceeded, coupon
  namespace isolation, cannot issue/coupon for a foreign merchant, cannot forge a
  victim card id, transfer cannot underflow, dust round-trips exactly.
- **Access0x1Nft** (`Access0x1Nft.attack.t.sol`): a re-entrant `buy` on NFT delivery is
  blocked (one-shot listing + `nonReentrant`), a contract buyer that cannot receive the
  ERC-721 rolls the whole payment back (atomic), the buyer's `maxPriceUsd8` consent blocks
  a seller price-bump, and a fuzzed `buy` conserves value with zero payment-token custody.
  Plus the 12 unit tests: escrow-on-list, settle-and-deliver, price-mismatch revert,
  seller-only cancel, merchant-owner-only / merchant-not-found / disallowed-token list
  guards, pause blocks trade but never cancel, and the zero-router constructor guard.
