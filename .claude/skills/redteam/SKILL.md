---
name: redteam
description: Dispatch the Fable red-team — five adversarial breakers (reentrancy, oracle, fee-math, token, access) attack the money path in test/attack/ and hand failing PoCs to proc-contracts. Run after each contract unit and before any deploy or submission.
---
# /redteam — break the money path before an attacker does

Dispatch the Fable adversarial red-team against the current `src/Access0x1Router.sol` (+ token / pool). Five Fable-model breakers, each **test-only** (`test/attack/**`, never `src/`):

1. `fable-redteam-reentrancy` — re-entry, cross-fn, read-only, CEI violations.
2. `fable-redteam-oracle` — stale / zero / negative price, decimals trap, round games.
3. `fable-redteam-fee-math` — dust theft, fee-cap bypass, conservation breaks.
4. `fable-redteam-token` — fee-on-transfer, rebasing, non-standard ERC-20, allowance races.
5. `fable-redteam-access` — owner / pause bypass, merchant isolation, orderId replay.

## How to run
- Run all five **in parallel** against the live contracts; each goes HARD (assume exploitable; stand down only when the sharpest attack reverts as the spec intends).
- A break = a failing PoC in `test/attack/` → hand to `proc-contracts` (opus) to fix → re-run that breaker until it can't break it.
- Output: per-breaker verdict (BROKEN + exploit path + severity, or CLEAN + attack log). Aggregate: every High / Critical fixed before the unit's PR is marked ready.

## When
After each contract unit lands (router-core, token, each pay path), and as a full sweep before deploy and before submission. Never weaken an assertion or delete a test to go green. The gate stays green; `src/` is touched only by `proc-contracts`. Fable (the orchestrator) adjudicates severity and merge-readiness — final call.
