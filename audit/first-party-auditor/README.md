# first-party auditor

A **pure audit agent**: it finds and reports security issues, and it **never
corrects them**. It separates finding from fixing — an auditor that also patches
is grading its own work.

## It's still us. Say so.

Be honest about what this is: the first-party auditor is **first-party**. We built
it, it runs on our own code, and however rigorous its rubric, an author's own
tool reviewing the author's own contracts is **self-review, not independent
review**. It does not — cannot — satisfy the independence that a real audit
provides, and no report it produces should be presented as a third-party audit.

The operator brings genuine smart-contract security experience, and experienced
first-party review beats naive review by a wide margin — it is a real mitigant,
and we state it as one. Experience reviewing your own code is still not the same
as independence, and we don't pretend it is.

**Our posture:** rigorous, tooled, experience-backed **first-party** review (this
agent + the operator) is the security review we run. An **independent
third-party audit is available and welcome** — it strengthens confidence and we
keep the `audit/` package ready so an external auditor starts from a clean,
well-mapped codebase, not a cold read — but it is **not a hard blocker** we
impose on ourselves. Going to mainnet on first-party review is a real,
operator-accepted risk; we name it as one rather than hide it behind a gate we'd
only wave through anyway.

This agent is the **continuous internal auditor** that keeps the repo
audit-ready and produces findings in the exact format an external auditor's
report uses.

## Files

| File | What it is |
| --- | --- |
| [`CHARTER.md`](CHARTER.md) | The governing spec: the no-corrections law, allowed tools, methodology, severity scale, finding format. |
| [`RUBRIC.md`](RUBRIC.md) | The 13-category manual-review checklist, phrased as attack questions the agent re-derives from code. |
| [`FINDING-TEMPLATE.md`](FINDING-TEMPLATE.md) | The per-finding block the agent fills; describes the fix in prose, never writes it. |

The runnable agent lives at `.claude/agents/first-party-auditor.md` (gitignored,
local tooling) with **read-only tools only** — the no-corrections law is enforced
at the tool level, not just asked for. This tracked charter is its source of
truth and what other engineers review.

## Run it

```
# in Claude Code, from the repo root:
Use the first-party-auditor agent to audit src/**
# or a narrower scope:
Use the first-party-auditor agent to audit src/ens/Access0x1PaymentResolver.sol
```

It reproduces the gate read-only, runs slither/aderyn, walks the rubric, reasons
adversarially, and writes a findings report — most-severe first, each labeled
CONFIRMED or PLAUSIBLE, ending with an honest scope + residual-risk footer. If
nothing survives verification it says so plainly. It changes no code.

## What it is not

- **Not independent.** It's us auditing us (see above). First-party, experience-
  backed, honest about being first-party.
- **Not a fixer.** Findings go to a human; corrections are a separate branch +
  PR through the normal build loop.
- An external audit is **available and welcome**, not a self-imposed blocker. It
  raises confidence; the operator owns the decision to seek one and the risk of
  shipping on first-party review.
