# Invariant catalog

The safety properties Access0x1 proves — the map an auditor (or a BlackRock/JPMorgan
due-diligence team) reads first. Every property below is enforced continuously by the
**Foundry invariant fuzzer** (random call sequences against the live contracts; the CI
profile runs 256×128 = 32,768 calls per target) and, for the money-split and
session-budget cores, by **halmos symbolic proofs** (exhaustive over all inputs, not
sampled). Counts as of 2026-07: **84 invariant functions across 15 suites + 4 symbolic
proofs**, all green.

Run them:

```sh
forge test --match-path 'test/**/*[Ii]nvariant*'   # the fuzzed invariants
halmos --match-contract 'FeeSplitSymbolic|SessionBudgetSymbolic'   # the symbolic proofs
```

## The cross-cutting properties (what every money contract guarantees)

| Property | Plain meaning | Why an institution cares |
|---|---|---|
| **Conservation** | Value in == value out, to the wei — no path mints or destroys funds (native, USDC, EURC, and arbitrary ERC-20s each checked). | Settlement is exact; no leak, no phantom balance. |
| **Zero custody** | The contract never holds user/merchant funds beyond the settlement tx; balances are always attributable and withdrawable by their owner. | No platform seizure surface; non-custodial by proof, not promise. |
| **Fee cap** | The total fee never exceeds `MAX_FEE_BPS`; `net + platformFee + merchantFee == gross`. | The buyer/merchant can never be over-charged by config. |
| **Merchant / lane isolation** | One merchant (or payment lane) can never read, move, or corrupt another's funds or config. | Multi-tenant safety — a shared rail with no cross-tenant bleed. |
| **At-most-once settlement** | An invoice/receivable/booking settles at most once; a cancelled/void item stays cancelled/void. | No double-charge, no replay of a completed payment. |
| **Canary always liquid** | A designated "canary" position stays claimable/settleable/refundable no matter what the fuzzer does around it — funds are never stranded or frozen. | Refunds and withdrawals can never be blocked. |
| **Exact split** | Multi-payee splits distribute the full amount with deterministic flooring and no remainder loss. | Payouts reconcile to the cent. |

## Per-contract invariants

| Contract | Suite | Invariants proved |
|---|---|---|
| **Access0x1Router** (the settle spine) | `Access0x1Router.invariant.t.sol` | conservation (native, token) · feeCap · merchantIsolation · platformCutToTreasury · zeroCustody |
| Router — *continue* mode | `RouterContinueInvariants.t.sol` | the same set under fail-soft continue semantics + `gettersCantRevert` |
| Router — *fail-on-revert* mode | `RouterFailOnRevertInvariants.t.sol` | the same set under strict fail-on-revert + `gettersCantRevert` |
| Router — fee edge cases | `RouterFeeEdge.invariant.t.sol` | edgeConservation · edgeFeeCap (min/max/boundary fee bps) |
| **PaymentLanes** (ERC-6909) | `PaymentLanesInvariant.t.sol` | conservation (USDC, EURC) · canaryLaneFrozen |
| PaymentLanes — cross-asset firewall (attack) | `PaymentLanesFirewallInvariant.attack.t.sol` | firewall conservation (USDC, EURC, and an adversarial "evil" token) · canaryFrozen — a hostile token cannot drain another lane |
| **SplitSettler** | `SplitSettlerInvariant.t.sol` | native/token conservation + balance-exact · splitAlwaysExact · canarySharesSumToTotal · canaryIsAlwaysSettleable |
| **Access0x1Escrow** | `EscrowInvariant.t.sol` | native/token conservation + balance-exact · openEscrowAlwaysFunded · openEscrowIsAlwaysResolvable · settledMatchesSinks · splitAlwaysExact |
| **Refunds** | `RefundsInvariant.t.sol` | native/token conservation + balance-exact · canaryAlwaysClaimable / canaryIsAlwaysClaimable · resolveAlwaysExact · receiptMatchesCanary |
| **GaslessPayIn** | `GaslessPayInInvariant.t.sol` | conservationMatchesSinks · zeroCustody (both the payin and the router leg) · noDanglingRouterAllowance |
| **Access0x1Subscriptions** | `Access0x1Subscriptions.invariant.t.sol` | conservation · neverPastBudget (the never-negative meter) · periodMonotonic · canaryIsolation · zeroCustody · tierIsPureView |
| **Access0x1Bookings** | `Access0x1Bookings.invariant.t.sol` | escrowAlwaysBacked · escrowConservation · feeNeverExceedsEscrow · canarySlotIsolation · routedMatchesSinks · policySnapshotImmutable |
| **Access0x1Invoices** | `Access0x1Invoices.invariant.t.sol` | native/token conservation · settlesAtMostOnce · voidCanaryStaysVoid · openCanaryUntouched · zeroCustody |
| **Receivables** | `Receivables.invariant.t.sol` | native/token conservation · settlesAtMostOnce · cancelCanaryStaysCancelled · openCanaryUntouched · zeroCustody |
| **GiftCards** | `GiftCardsInvariant.t.sol` | conservation (per card) · couponCapNeverExceeded · canaryCardFrozen |

## Symbolic proofs (halmos — exhaustive, not sampled)

| Proof | Suite | What it proves for ALL inputs |
|---|---|---|
| Fee split conserves value | `FeeSplitSymbolic.t.sol` `check_feeSplit_conservesValue` | for every gross + bps, `net + fees == gross` exactly |
| Fee split never mints | `FeeSplitSymbolic.t.sol` `check_feeSplit_neverMintsValue` | no input causes the split to create value |
| Spend never exceeds budget | `SessionBudgetSymbolic.t.sol` `check_spend_neverExceedsBudget` | a single SessionGrant spend can never exceed the remaining budget |
| Two spends never exceed budget | `SessionBudgetSymbolic.t.sol` `check_twoSpends_neverExceedBudget` | two sequential spends can never jointly exceed the budget (no accounting drift) |

## How to keep this current

This catalog is generated from the suites — after adding or renaming an
`invariant_*` / `check_*` function, regenerate the join:

```sh
for f in $(grep -rlE 'function (invariant_|check_)' test/); do
  echo "### $(basename "$f")"; grep -oE 'function (invariant_|check_)[A-Za-z0-9_]+' "$f" | sed 's/function /  /' | sort -u
done
```

Every money contract carries **conservation + zero-custody**; the router adds
**fee-cap + isolation + platform-cut**; the commerce contracts add **at-most-once +
canary-liquidity**. That is the whole safety spine, in one page.
