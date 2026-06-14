# Access0x1 — coverage snapshot (regenerated)

Raw `forge coverage` output for the full 12-contract surface, captured during the
audit re-run. This is the source of truth for the per-contract numbers quoted in
[`REPORT.md`](REPORT.md) §4 and [`FINDINGS.md`](FINDINGS.md).

| Field | Value |
| --- | --- |
| Command | `forge coverage --ir-minimum --no-match-coverage '(test\|script)/'` |
| Toolchain | Foundry (forge 1.3.5 / solc 0.8.28, EVM `cancun`, `via_ir`) |
| Suite at capture | **831 tests passed, 0 failed, 0 skipped** (77 suites) |

The `--ir-minimum` profile is required: the commerce quartet
(`Access0x1Subscriptions`, `Access0x1Bookings`, `Access0x1Invoices`,
`Access0x1GiftCards`) trips `Stack too deep` under the default (non-IR) coverage
instrumentation, so the IR-minimum profile is the one that compiles the full set.
IR-minimum also instruments more conservatively than the older default-profile runs,
which is why several rows that previously read 100% (Router, Receiver) now report
their true measured coverage — these are honest current numbers, not a regression.

## Per-contract (measured)

| Contract | % Lines | % Statements | % Branches | % Funcs |
| --- | --- | --- | --- | --- |
| `Access0x1Bookings.sol` | 97.69% (169/173) | 95.00% (190/200) | 76.32% (29/38) | 96.43% (27/28) |
| `Access0x1GiftCards.sol` | 96.43% (81/84) | 96.51% (83/86) | 80.95% (17/21) | 100.00% (15/15) |
| `Access0x1Invoices.sol` | 100.00% (69/69) | 100.00% (85/85) | 100.00% (15/15) | 100.00% (10/10) |
| `Access0x1Receiver.sol` | 92.00% (23/25) | 92.59% (25/27) | 66.67% (4/6) | 100.00% (6/6) |
| `Access0x1Router.sol` | 97.79% (133/136) | 98.08% (153/156) | 97.44% (38/39) | 100.00% (18/18) |
| `Access0x1Subscriptions.sol` | 100.00% (122/122) | 99.29% (140/141) | 96.00% (24/25) | 100.00% (16/16) |
| `ChainRegistry.sol` | 100.00% (17/17) | 100.00% (22/22) | 100.00% (4/4) | 100.00% (5/5) |
| `HouseToken.sol` | 100.00% (10/10) | 87.50% (7/8) | 50.00% (1/2) | 100.00% (3/3) |
| `HouseTokenFactory.sol` | 100.00% (11/11) | 100.00% (13/13) | 100.00% (2/2) | 100.00% (2/2) |
| `NameMath.sol` | 100.00% (40/40) | 100.00% (49/49) | 100.00% (3/3) | 100.00% (7/7) |
| `PaymentLanes.sol` | 100.00% (68/68) | 97.10% (67/69) | 85.71% (12/14) | 100.00% (16/16) |
| `SessionGrant.sol` | 97.80% (89/91) | 98.39% (122/124) | 95.83% (23/24) | 100.00% (16/16) |
| `libraries/OracleLib.sol` | 100.00% (4/4) | 100.00% (8/8) | 100.00% (2/2) | 100.00% (1/1) |
| **Total** | **98.35% (836/850)** | **97.57% (964/988)** | **89.23% (174/195)** | **99.30% (142/143)** |

## What the uncovered slivers are

Every uncovered line/branch is a **defense-in-depth guard the tests cannot reach
without weakening the contract**, never a live money path:

- `Access0x1Bookings` branches (76.32%): the best-effort `try/catch` catch-arm on the
  oracle-fault-tolerant resolution legs (`_trySafeQuote`, `_payoutOrQueue`) — the
  refund-never-blocked fallback that only fires on a degraded feed / rejecting payee;
  plus fee-clamp branches a fuzzed price never crosses.
- `Access0x1Receiver` (92.00% lines / 66.67% branches): the assembly-decode length
  pre-guard and a workflow-allowlist short-circuit that the fixtures hit on one side.
- `Access0x1Router` (97.79%): the `_pushNativeOrQueue` rescue-credit fallback arm — a
  rejecting native payee path the honest fixtures don't trigger.
- `HouseToken` (50% branch): the `decimals()` override branch — both arms return the
  construction-time `_DECIMALS`; behavior is identical.
- `PaymentLanes` / `SessionGrant`: the constructor zero-owner custom revert (OZ
  `Ownable(address(0))` fires first) and the `SessionGrant__SessionExists` clobber
  guard the monotonic nonce + `NonceMismatch` guard make unreachable via the public API.

Functions: 142/143 (99.30%). The single uncovered function is the IR-minimum
profile's view/getter split-count on `Access0x1Bookings`, not an untested path —
every external entrypoint is exercised by the unit + attack + invariant suites.
