# Access0x1 — Solodit / Cyfrin Smart-Contract Audit Checklist

> The standard Solodit/Cyfrin pre-audit checklist, walked item by item for the Access0x1 first-party
> contracts. Each row gives the **compliance line** (how the codebase addresses the class) and the
> **test that proves it**. This is an engineering self-audit aid, NOT a third-party audit (see
> `audit/REPORT.md` §8 for the honest mainnet-readiness disposition).
>
> Toolchain: Foundry (solc 0.8.28, EVM cancun, via_ir), Aderyn, Slither, `forge coverage`, plus the
> Halmos symbolic proofs in `test/symbolic/`. Money contracts in scope: `Access0x1Router`,
> `SessionGrant`, `Access0x1Subscriptions`, `Access0x1Bookings`, `Access0x1Invoices`,
> `Access0x1GiftCards`, `PaymentLanes`.

## How to read this

- **Status:** ✅ addressed · ⚠️ addressed with a documented caveat · N/A not applicable to this scope.
- **Proof:** a concrete test path (run `forge test --match-path <p>`) or a tool target (`make <t>`).

---

## 1. Reentrancy

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| External calls after state changes (CEI) | ✅ | Every money path writes effects before interactions: `Invoices.pay` flips `status = PAID` before the router call; `GiftCards.redeem` records the redemption + debits before any event; `Bookings` writes the escrow ledger before each transfer. | `test/attack/Access0x1Router.attack.t.sol`, `test/attack/Access0x1Invoices.attack.t.sol` |
| `nonReentrant` on value paths | ✅ | OZ `ReentrancyGuard` on `payNative`/`payToken`/`claimRescue` (Router), `pay`/`payNative` (Invoices), `reserve`/`confirm`/`complete`/`cancel`/`markNoShow`/`claimRefund` (Bookings), `subscribe`/`renew`/`cancel` (Subscriptions), `issueCard`/`redeem`/`reverseRedemption` (GiftCards). | `test/attack/RouterMoneyFailure.attack.t.sol` (reentrant token mocks) |
| Cross-function reentrancy | ✅ | Router `rescue` is written only behind the shared `nonReentrant` guard that `payNative`/`payToken`/`claimRescue` all share; Subscriptions charges behind a `chargeViaSelf` external boundary re-asserting `msg.sender == this`. | `test/mocks/MockReentrantToken.sol`, `ReentrantPayout.sol`, `ReentrantClaimToken.sol` |
| Read-only reentrancy | ✅ | No external integrator reads mid-settlement state; views (`quote`, `effectiveTier`, `remaining`) are pure reads of committed state. | `test/unit/*` view tests |

## 2. Oracle / price feed

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| Staleness check | ✅ | `OracleLib.staleCheckLatestRoundData` reverts on `block.timestamp - updatedAt > 3600s`. | `test/unit/OracleLib.t.sol`, `test/fork/ChainlinkFeedFork.t.sol` |
| Incomplete / carried-over round | ✅ | Reverts on `updatedAt == 0` or `answeredInRound < roundId`. | `test/unit/OracleLib.t.sol` (full 5-tuple mock) |
| Non-positive price | ✅ | `Router.quote` reverts `Access0x1__InvalidPrice` on `answer <= 0`. | `test/unit/Access0x1Router.t.sol` |
| Decimals read live, never hardcoded | ✅ | `feed.decimals()` + token `decimals()` read in-tx (the Arc trap: native USDC 18-dec vs ERC-20 USDC 6-dec vs feed 8-dec). | `test/integration/EndToEnd.t.sol`, `test/unit/Access0x1Router.t.sol` |
| Oracle outage must not brick refunds | ✅ | `Bookings` resolution legs wrap `quote` in try/catch: a stale feed makes the fee leg take **nothing** and refund the FULL escrow. | `test/scenario/SalonBooking.scenario.t.sol::test_scenario_salon_noShow_staleFeed_refundsFullEscrow_neverBlocked` |

## 3. Access control

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| Admin uses 2-step ownership | ✅ | `Ownable2Step` on Router, Subscriptions, Bookings, GiftCards, ChainRegistry, Receiver. | `test/unit/Access0x1Router.t.sol` (transfer/accept) |
| Per-merchant authority | ✅ | The Router merchant registry is the single source of truth: `onlyMerchantOwner` reads `router.merchants(id).owner` everywhere (Subscriptions/Bookings/Invoices/GiftCards). | `test/unit/*` not-owner revert paths |
| Privilege escalation | ✅ | A merchant can never redirect the platform fee leg (`_splitFee` always sends the platform cut to `platformTreasury`). | `test/attack/Access0x1Router.attack.t.sol` |
| Tenant isolation | ✅ | A payment/op against merchant A never mutates merchant B; coupons + cards are namespaced under `merchantId`. | `test/invariant/Access0x1Router.invariant.t.sol` (isolation invariant) |

## 4. Checks-Effects-Interactions (CEI)

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| State written before external calls | ✅ | See §1; `claimRescue`/`claimRefund` zero the credit before the send. | `test/attack/Access0x1Router.attack.t.sol` |
| No external call can re-enter a stale state | ✅ | Terminal flips (`PAID`/`CANCELLED`/`COMPLETED`) precede transfers. | `test/scenario/InvoicePayOnce.scenario.t.sol` |

## 5. Arithmetic / rounding

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| Fee split conserves value | ✅ | `net + platformFee + merchantFee == gross` exactly; each leg floors. **Proven symbolically.** | `test/symbolic/FeeSplitSymbolic.t.sol::check_feeSplit_conservesValue` (`make halmos`); `test/invariant/Access0x1Router.invariant.t.sol` |
| Rounding direction is safe | ✅ | `quote` rounds UP (merchant never under-paid, dust ≤ 1 wei); fee legs round DOWN (buyer never over-charged). | `test/unit/Access0x1Router.t.sol` rounding cases |
| Never-negative balance / budget | ✅ | `SessionGrant.spend` hard-reverts past cap; `GiftCards.redeem` applies `min(balance, amount)` and the balance floors at zero. **Proven symbolically.** | `test/symbolic/SessionBudgetSymbolic.t.sol::check_spend_neverExceedsBudget` (`make halmos`); `test/scenario/GiftCardNeverNegative.scenario.t.sol` |
| Over/underflow | ✅ | solc 0.8.28 checked math; `unchecked` blocks are each justified by an in-scope proven bound. | `test/invariant/**` (fail_on_revert invariants) |

## 6. Fee-on-transfer / rebasing tokens

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| Balance-delta verification | ✅ | `_pullExact` (Router + Invoices) and `reserve` (Bookings) assert `received == amount` and revert `FeeOnTransferToken` otherwise. | `test/mocks/FeeOnTransferToken.sol`, `test/attack/Access0x1Bookings.attack.t.sol` |
| Tokens returning nothing on transfer | ✅ | `SafeERC20` everywhere; non-bool/garbage returns handled. | `test/mocks/MockReturnsNothingToken.sol` |

## 7. Decimals

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| Non-18-decimal tokens | ✅ | `MockUSDC` is 6-dec by design; `quote` reads token + feed decimals live. | `test/integration/EndToEnd.t.sol` (250e6 == $250) |
| USD accounting unit pinned | ✅ | All USD values are 8-dp (`usdAmount8`), matching Chainlink USD feeds. | `test/unit/Access0x1Router.t.sol` |

## 8. Replay / signature

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| Signature replay | ✅ | `SessionGrant` pins a per-owner monotonic nonce into the EIP-712 digest; a consumed grant collides with the session id and reverts `SessionExists`. | `test/attack/SessionGrant.attack.t.sol` |
| ERC-1271 / ERC-6492 / EOA validation | ✅ | `_isValidSignatureNow` validates all three; `tryRecover` (not `recover`) so a garbage sig is a clean reject. | `test/unit/SessionGrant.t.sol`, `test/mocks/SmartWallet1271.sol` |
| Idempotency / pay-once | ✅ | Invoices `OPEN → {PAID,VOID}` one-way; Bookings `clientNonce` guard; GiftCards `redemptionId` one-shot. | `test/scenario/InvoicePayOnce.scenario.t.sol`, `test/scenario/GiftCardNeverNegative.scenario.t.sol` |
| ERC-6492 factory reentrancy | ✅ | The only external call (6492 factory prepare) cannot double-open: `_open` pins the validated nonce and reverts on mismatch. | `test/attack/SessionGrant.attack.t.sol::test_attack_reentrancy_6492_cannotDoubleOpen` |

## 9. Denial of service (DoS)

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| A reverting payee cannot block settlement | ✅ | Router native pushes that fail are queued to `rescue` (pull-pattern); Bookings refunds that fail land in `refundRescue`. | `test/mocks/RevertingReceiver.sol`, `test/attack/Access0x1Bookings.attack.t.sol` |
| Gas griefing | ✅ | Native sends use a low-level call (no 2300 cap); the failure path is a bounded single SSTORE. | `test/attack/GasGriefProbe.t.sol` |
| Unbounded loops | ✅ | No money path iterates an attacker-controllable array; lane/escrow are O(1) per-key maps. | manual review (§ REPORT.md) |

## 10. Pausability

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| Circuit breaker on new pay-ins | ✅ | Router `pause()` gates `payNative`/`payToken` (`whenNotPaused`). | `test/unit/Access0x1Router.t.sol` |
| Pause never traps owed funds | ✅ | `claimRescue` is deliberately NOT gated by the pause — owed funds stay withdrawable. | `test/unit/Access0x1Router.t.sol` (claim while paused) |

## 11. Upgradeability / storage

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| No proxy / no upgrade surface | ✅ | All contracts are non-upgradeable (no proxy, no `delegatecall` to user code). A new version is a new deployment. | `make storage-layout` → `docs/STORAGE-LAYOUT.md` |
| Storage layout documented | ✅ | Slot layout of every stateful contract is captured for audit review. | `docs/STORAGE-LAYOUT.md` |
| Slot packing claims verified | ✅ | The Merchant struct packs `feeRecipient+feeBps+active`; the doc confirms the offsets. | `docs/STORAGE-LAYOUT.md` |

## 12. Refunds never blocked (estate law #5)

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| Money rolls back, never swallowed | ✅ | Subscriptions renewal failure rolls back the whole charge (no budget consumed) and duns instead of reverting the keeper. | `test/scenario/SaasSubscription.scenario.t.sol` |
| A refund is always reachable | ✅ | Blocklisted/reverting refund recipients are credited to a pull-map (`rescue`/`refundRescue`), claimable later. | `test/mocks/BlocklistToken.sol`, `test/scenario/SalonBooking.scenario.t.sol` |
| Oracle outage cannot strand a deposit | ✅ | See §2 last row — a dead feed refunds the full escrow. | `test/scenario/SalonBooking.scenario.t.sol` |

## 13. Zero custody

| Item | Status | Compliance line | Proof |
| --- | --- | --- | --- |
| Contract holds ~zero token after settlement | ✅ | Router/Invoices/Subscriptions push net+fee out in the same tx; residual approvals are reset to 0. | `test/scenario/CoffeeShopPayment.scenario.t.sol`, `test/integration/EndToEnd.t.sol` |
| Escrow is fully backed | ✅ | Bookings: `balanceOf(token) == escrowedOf(token) == Σ live escrow` (conservation). | `test/invariant/Access0x1Bookings.invariant.t.sol` |
| Lane receipts are non-custodial pulls | ✅ | PaymentLanes credits a receipt the merchant pulls via `claim`; per-asset firewall + conservation. | `test/invariant/PaymentLanesInvariant.t.sol`, `test/attack/PaymentLanesFirewall.attack.t.sol` |

---

## Tooling coverage map

| Practice | Target | Status here |
| --- | --- | --- |
| Unit + revert-path tests | `forge test` | ✅ runs in the gate |
| Invariant (dual continue/fail-on-revert) | `test/invariant/**` | ✅ runs in the gate |
| Adversarial / red-team | `test/attack/**` | ✅ runs in the gate |
| Scenario / end-to-end | `make test-scenario` | ✅ runs in the gate |
| Static analysis | `make slither`, `make aderyn`, `make analyze` | ✅ slither+aderyn; ⚠️ 4naly3er best-effort (network) |
| Symbolic execution | `make halmos` | ✅ Halmos proofs in `test/symbolic/` |
| Mutation testing | `make mutation` | ⚠️ documented target (gambit/vertigo-rs install on demand) |
| Coverage gate | `make coverage-lcov` | ✅ emits lcov.info; documented floor 90% on money paths |
| Contract sizes (EIP-170) | `make sizes` | ✅ `forge build --sizes` |
| Storage layout | `make storage-layout` | ✅ `docs/STORAGE-LAYOUT.md` |
| zkEVM build | `make zksync-build` | ⚠️ see `docs/ZKSYNC-TESTING.md` (EVM-green != zkSync-green) |
| Gas snapshot | `make snapshot` | ✅ `.gas-snapshot` checked in |
