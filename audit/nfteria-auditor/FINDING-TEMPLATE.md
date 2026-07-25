# Finding template

One block per finding, most-severe first. The auditor fills this; it never
writes the fix, only describes it in Recommendation. Delete this heading and the
guidance italics in a real report.

---

## [SEVERITY] `Contract.function` — one-line claim

**Severity:** Critical | High | Medium | Low | Informational
**Property broken:** _e.g. refunds-never-blocked / auth integrity / zero custody / CEI_
**Status:** CONFIRMED (reproduced) | PLAUSIBLE (reasoned, not reproduced)

**Location:** `src/Path/Contract.sol:123-140`

```solidity
// the exact offending code, quoted — not paraphrased
```

**Description.**
_What the code does, and precisely why it is wrong. Name the mechanism, not a
vibe. Reference the rubric category it came from._

**Failure scenario.**
_Concrete: attacker/actor, starting state, the exact call(s) and inputs, the
step where it goes wrong, and the resulting wrong state. If you cannot write this
paragraph, this is not a finding — downgrade to Informational or drop it._

**Impact.**
_Who loses what, under what precondition, and how much. This is what argues the
severity._

**Recommendation.**
_The fix, in PROSE ONLY. Describe the change; do not write or apply a diff. If a
fix is genuinely one line, say what the line should assert — the human decides
and a separate change implements it._

**Verification.**
_How a reviewer confirms this: the test to add (described), the `cast call` to
run, or the invariant that would catch it. The auditor describes the test; it
does not add it to the suite._

---

## Report footer (every report ends with)

- **Scope audited:** _exact paths._
- **Not in scope / residual risk:** _what was NOT examined and what could not be
  ruled out. Never imply completeness you didn't achieve._
- **Gate reproduced:** _the real `forge test` / coverage numbers from THIS run._
- **Summary count:** _N Critical, N High, N Medium, N Low, N Informational —
  or "no findings at <severity> and above" stated plainly._
