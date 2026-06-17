# specs/ — the spec-driven trail

> Spec-driven development is permitted at ETHGlobal **as long as every spec file,
> prompt, and planning artifact is in the submission repo** — so judges see how the
> AI was directed, not just the output. This directory is that trail. The AI tool
> and the per-file split are disclosed in [`../AI_ATTRIBUTION.md`](../AI_ATTRIBUTION.md).

Access0x1 was built by **Claude Code** running a multi-agent harness, against a
fixed, written specification. These files are the spec that drove the build — the
plans the agents were handed, not a retro-fit. They are reproduced from the
authoritative, in-repo doctrine so the spec lives **with** the code it produced.

## What's here

| File | What it is |
| --- | --- |
| [`OPERATING-DOCTRINE.md`](./OPERATING-DOCTRINE.md) | The WOW mandate, the laws, and the decide-vs-ask gates — the brief every unit was held to. |
| [`BUILD-ORDER.md`](./BUILD-ORDER.md) | The dependency-ordered unit list (the build plan) + the per-unit Sonnet→Opus→review→red-team→merge pipeline. |
| [`COMMIT-DISCIPLINE.md`](./COMMIT-DISCIPLINE.md) | The seven commit laws + the branch/PR flow that make the git log itself a proof artifact. |

## The authoritative sources (also in this repo)

These specs are summaries/captures; the live, enforced sources of truth are:

- [`../CLAUDE.md`](../CLAUDE.md) — the full operating doctrine that auto-loads for
  any Claude session in the repo.
- [`../.claude/rules/`](../.claude/rules) — always-on rules:
  [`stack.md`](../.claude/rules/stack.md),
  [`git-workflow.md`](../.claude/rules/git-workflow.md),
  [`testing.md`](../.claude/rules/testing.md),
  [`model-policy.md`](../.claude/rules/model-policy.md),
  [`security.md`](../.claude/rules/security.md),
  [`accounts.md`](../.claude/rules/accounts.md).
- [`../.claude/hooks/`](../.claude/hooks) — the PreToolUse guard that *enforces* the
  commit/secret laws on every shell call (the spec is not just aspirational).
- [`../PROGRESS.md`](../PROGRESS.md) — the running done-log: which unit landed, its
  green-proof, and its merge SHA.

## How to read the trail

The spec → output mapping is direct and verifiable:

1. `BUILD-ORDER.md` lists the units in dependency order.
2. Each unit became **one branch → one merge-commit PR** (see the public PR list).
3. `PROGRESS.md` records each landing with its green-proof.
4. The per-function commits inside each PR are the
   [`git log`](https://github.com/Access0x1/Access0x1/commits/main) — the build-time
   proof that the spec was followed one deliberate move at a time.
