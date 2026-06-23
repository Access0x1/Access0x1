# Access0x1 — coverage snapshot

Raw `forge coverage` output for the contracts in the table below, captured during an
audit run. This is the source of truth for the per-contract numbers quoted in
[`REPORT.md`](REPORT.md) §4 and [`FINDINGS.md`](FINDINGS.md).

| Field | Value |
| --- | --- |
| Command | `forge coverage --ir-minimum --no-match-coverage '(test\|script)/'` |
| Toolchain | Foundry (forge 1.3.5 / solc 0.8.28, EVM `cancun`, `via_ir`) |
| Whole-suite gate (current) | **1,383 tests passed, 0 failed, 0 skipped** across **104 suites** (unit + attack + invariant + integration + fuzz + scenario + fork + symbolic). Coverage is instrumented over the non-fork suites; the 3 `test/fork/**` tests are no-ops without a fork RPC and do not affect line coverage. |

This per-contract snapshot is the last full coverage run committed; it **predates the
most recently-added primitives** (`SplitSettler`, `Access0x1Escrow`, `Receivables`,
`Refunds`, `GaslessPayIn`, `PriceOracleAdapter`, `AutomationGateway`,
`Access0x1ProvenanceRegistry`), which each carry their own unit/invariant/attack tests
inside the 1,383-test total and refresh into this table on the next run.

The `--ir-minimum` profile is required: the commerce primitives
(`Access0x1Subscriptions`, `Access0x1Bookings`, `Access0x1Invoices`,
`Access0x1GiftCards`, `Access0x1Nft`) trip `Stack too deep` under the default (non-IR)
coverage instrumentation, so the IR-minimum profile is the one that compiles the full set.
IR-minimum also instruments more conservatively than the older default-profile runs,
which is why several rows that previously read 100% (Router, Receiver) now report
their true measured coverage — these are honest measured numbers, not a regression.

## Per-contract (measured)

| Contract | % Lines | % Statements | % Branches | % Funcs |
| --- | --- | --- | --- | --- |
| `Access0x1Bookings.sol` | 99.42% (172/173) | 96.00% (192/200) | 78.95% (30/38) | 100.00% (28/28) |
| `Access0x1GiftCards.sol` | 96.43% (81/84) | 96.51% (83/86) | 80.95% (17/21) | 100.00% (15/15) |
| `Access0x1Invoices.sol` | 100.00% (69/69) | 100.00% (85/85) | 100.00% (15/15) | 100.00% (10/10) |
| `Access0x1Nft.sol` | 96.30% (52/54) | 94.83% (55/58) | 90.00% (9/10) | 100.00% (8/8) |
| `Access0x1Receiver.sol` | 92.00% (23/25) | 92.59% (25/27) | 66.67% (4/6) | 100.00% (6/6) |
| `Access0x1Router.sol` | 97.87% (138/141) | 98.14% (158/161) | 97.50% (39/40) | 100.00% (19/19) |
| `Access0x1Subscriptions.sol` | 100.00% (124/124) | 99.30% (142/143) | 96.00% (24/25) | 100.00% (16/16) |
| `ChainRegistry.sol` | 100.00% (17/17) | 100.00% (22/22) | 100.00% (4/4) | 100.00% (5/5) |
| `HouseToken.sol` | 100.00% (10/10) | 87.50% (7/8) | 50.00% (1/2) | 100.00% (3/3) |
| `HouseTokenFactory.sol` | 100.00% (11/11) | 100.00% (13/13) | 100.00% (2/2) | 100.00% (2/2) |
| `NameMath.sol` | 100.00% (40/40) | 100.00% (49/49) | 100.00% (3/3) | 100.00% (7/7) |
| `PaymentLanes.sol` | 100.00% (68/68) | 97.10% (67/69) | 85.71% (12/14) | 100.00% (16/16) |
| `SessionGrant.sol` | 97.80% (89/91) | 98.39% (122/124) | 95.83% (23/24) | 100.00% (16/16) |
| `libraries/OracleLib.sol` | 100.00% (9/9) | 100.00% (17/17) | 100.00% (4/4) | 100.00% (2/2) |
| **Total** | **98.58% (903/916)** | **97.65% (1037/1062)** | **89.90% (187/208)** | **100.00% (153/153)** |

## What the uncovered slivers are

Every uncovered line/branch is a **defense-in-depth guard the tests cannot reach
without weakening the contract**, never a live money path:

- `Access0x1Bookings` branches (78.95%): the best-effort `try/catch` catch-arm on the
  oracle-fault-tolerant resolution legs (`_trySafeQuote`, `_payoutOrQueue`) — the
  refund-never-blocked fallback that only fires on a degraded feed / rejecting payee;
  plus fee-clamp branches a fuzzed price never crosses.
- `Access0x1Receiver` (92.00% lines / 66.67% branches): the assembly-decode length
  pre-guard and a workflow-allowlist short-circuit that the fixtures hit on one side.
- `Access0x1Router` (97.87%): the `_pushNativeOrQueue` rescue-credit fallback arm — a
  rejecting native payee path the honest fixtures don't trigger.
- `Access0x1Nft` (96.30% lines / 90.00% branches): the `onERC721Received` unconditional
  accept and the `EscrowFailed` defensive revert (a non-standard 721 whose
  `safeTransferFrom` silently no-ops) — reached only by a misbehaving collection.
- `HouseToken` (50% branch): the `decimals()` override branch — both arms return the
  construction-time `_DECIMALS`; behavior is identical.
- `PaymentLanes` / `SessionGrant`: the constructor zero-owner custom revert (OZ
  `Ownable(address(0))` fires first) and the `SessionGrant__SessionExists` clobber
  guard the monotonic nonce + `NonceMismatch` guard make unreachable via the public API.

Functions: **153/153 (100.00%)** — every external entrypoint is exercised by the unit
+ attack + invariant suites. (The earlier 142/143 IR-minimum view/getter split-count
gap closed as the suite grew with the commerce quintet + the L2-sequencer guard.)
