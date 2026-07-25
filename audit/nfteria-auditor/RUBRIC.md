# nfteria auditor — rubric

The 13-category manual-review checklist, phrased as **attack questions**. The
auditor re-derives the answer from the code for each in-scope contract — it never
trusts the repo's own compliance table (`audit/CHECKLIST.md`) as proof. That
table is the *claim under audit*, not the evidence.

For every question: answer from the code, cite `file:line`, and when the answer
is "safe", say *why* (the specific guard). A "yes it's fine" with no cited
mechanism is not a finding of safety — it's an unverified assumption to flag.

## 1. Reentrancy
- Is every value-moving external call preceded by the state write it depends on (CEI)?
- Is `nonReentrant` on every path that sends value or reads-then-writes a balance?
- Can a malicious token / ERC-6492 factory / 1271 wallet / receive() re-enter and open a second effect on one authorization?
- Cross-function: can path A re-enter path B and act on B's stale state?
- Read-only reentrancy: does any external integrator read mid-settlement state?

## 2. Oracle / price feed
- Staleness: is `updatedAt` age bounded and does it revert past the bound?
- Incomplete round: `updatedAt == 0` / `answeredInRound < roundId` handled?
- Non-positive price rejected (`answer <= 0`)?
- Are token + feed decimals read live, never hardcoded?
- Does an oracle outage brick a **refund** anywhere? (refunds-never-blocked, §12)
- L2: is a sequencer-uptime + grace-period check present where it matters?

## 3. Access control
- 2-step ownership on every admin surface?
- Is authority read from the single source of truth (the merchant registry), not a local copy?
- Can any actor redirect the platform fee, mint, upgrade, or pause without the role?
- Tenant isolation: can an op on merchant A touch merchant B's state/funds?

## 4. Checks-Effects-Interactions
- Is every terminal status flip (PAID/CANCELLED/COMPLETED) written before its transfer?
- Can any external call re-enter a not-yet-finalized state?

## 5. Arithmetic / rounding
- Does the fee split conserve value exactly (`net + fees == gross`), and which way does it floor?
- Any unchecked block that can actually overflow/underflow with reachable inputs?
- Rounding direction: does dust favor the protocol or the user, and is that intended?

## 6. Fee-on-transfer / rebasing tokens
- Is received amount measured by balance delta, not the requested amount?
- Are FoT/rebasing tokens rejected or handled — never assumed 1:1?

## 7. Decimals
- Every cross-decimal conversion explicit and correct (6/8/18, native vs ERC-20 USDC)?

## 8. Replay / signature
- Nonce or deadline on every signed message; domain separator bound to chain id + contract?
- Is the validated value (e.g. nonce) the one actually used downstream, not a re-read?
- Cross-chain / cross-contract replay of the same signature possible?

## 9. Denial of service
- Any unbounded loop over user-growable data on a money path?
- Can one participant block others (a stuck recipient, a reverting callback, gas griefing)?
- Push vs pull for payouts — can a bad recipient wedge settlement?

## 10. Pausability
- If pausable, can pause block a refund or trap escrow? (pause must never lock user funds)

## 11. Upgradeability / storage
- UUPS: is `_authorizeUpgrade` gated? initializer locked (no re-init)?
- Storage layout: gaps present, no reordering across versions, no collision via inheritance?

## 12. Refunds never blocked (money-safety invariant #5)
- Is every refund/rescue/withdraw path unconditional — no oracle, allowlist, or pause dependency that can brick it?
- Does a fee re-quote on a resolution leg fall to zero (not revert) on a bad price?

## 13. Zero custody
- Does the protocol ever hold user funds beyond the atomic settlement it's mid-executing?
- Is every held balance (escrow, gateway) withdrawable by its rightful owner under all states?

## Cross-cutting (always)
- **Trust model:** what does the code *assume* about the operator/merchant/oracle, and is that assumption stated honestly (not hidden)?
- **Copy vs reality:** does any `AUDIT.md`/README claim ("live", "shipped", "anchored") exceed what the code + a mined tx actually prove? (law 4)
- **Failure mode:** on every external dependency failure, does the path degrade safely or lock/lose value?
