# specs/ — the spec-driven trail

> Spec-driven development is permitted at ETHGlobal **as long as every spec file,
> prompt, and planning artifact is in the submission repo** — so judges see how the
> AI was directed, not just the output. This directory is that trail. The AI tool
> and the per-file split are disclosed in [`../AI_ATTRIBUTION.md`](../AI_ATTRIBUTION.md).

Access0x1 was built by **Claude Code** running a multi-agent harness, against a
fixed, written specification. These files are the spec that drove the build — the
plans the agents were handed, not a retro-fit. They are reproduced here from the
authoritative local doctrine so the spec ships **with** the code it produced.

## What's here

| File | What it is |
| --- | --- |
| [`OPERATING-DOCTRINE.md`](./OPERATING-DOCTRINE.md) | The WOW mandate, the laws, and the decide-vs-ask gates — the brief every unit was held to. |
| [`BUILD-ORDER.md`](./BUILD-ORDER.md) | The dependency-ordered unit list (the build plan) + the per-unit Sonnet→Opus→review→red-team→merge pipeline. |
| [`COMMIT-DISCIPLINE.md`](./COMMIT-DISCIPLINE.md) | The seven commit laws + the branch/PR flow that make the git log itself a proof artifact. |

## The authoritative sources (local build tooling, not published)

These specs are the captured, published summaries. The live, enforced sources that
drove the build were the project's local Claude Code harness — an auto-loading
operating doctrine plus always-on rules (stack, git-workflow, testing, model-policy,
security, accounts) and a PreToolUse hook that *enforced* the commit/secret laws on
every shell call. That harness is local build tooling, kept out of the published
repo by design; what it produced — the spec captured here and the public git history
— is what ships.

## How to read the trail

The spec → output mapping is direct and verifiable:

1. `BUILD-ORDER.md` lists the units in dependency order.
2. Each unit became **one branch → one merge-commit PR** (see the public PR list).
3. The per-function commits inside each PR are the
   [`git log`](https://github.com/Access0x1/Access0x1/commits/main) — the build-time
   proof that the spec was followed one deliberate move at a time.
