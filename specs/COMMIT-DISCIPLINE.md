# Spec: the commit discipline

The git log is the product as much as the code is. A judge opening the history
should watch the system grow one deliberate move at a time. This is the spec that
made that true; it was enforced by the local build harness's git-workflow rule and a
PreToolUse hook that *blocked* violations on every shell call (the discipline is
mechanically enforced, not just documented).

## The seven commit laws

1. **One idea per commit** — one function, one test, one fix, one doc section. If
   the message needs "and", split it.
2. **One coherent idea, right-sized** — a whole function + NatSpec, a whole test, a
   focused fix; typically 20–80 lines. The idea is the unit, not a line count —
   never split a coherent function or pad to hit a number.
3. **Active cadence, no batches** — commit minutes apart as work happens, and push
   every commit to its public branch within minutes. A quiet repo during the build
   window is a bug. (1inch disqualifies single-commit dumps.)
4. **Green at merge; frequent on the branch** — main is always green (the full gate
   runs at the merge). On an agent branch, commit freely and frequently —
   RED-while-building is fine; the cadence is the proof, not a per-commit gate.
   Never `--no-verify`; never weaken a test to pass the gate.
5. **Messages narrate intent** — `feat(router): quote() reads the ETH/USD feed with
   a 1h staleness guard`. No `wip`, no `fix stuff`.
6. **Public from commit #1** — feature branches are pushed immediately (a pushed
   public branch is not staging); no force-push anywhere.
7. **The function is the unit of progress** — write, test, commit, next. No skeleton
   dumps of twenty empty functions.

## The branch + PR flow

- **Bootstrap exception:** the first commits (the discipline, the Foundry scaffold,
  the local build harness, the deps) land directly on `main` — an empty repo has
  nothing to review. The branch law starts at the first feature commit.
- **Branch = the agent's name** — e.g. `proc-contracts/router-core`, `chain-base`,
  `fable-redteam-oracle`. Parallel agents run in **isolated worktrees** so they
  never collide; within a unit, exactly one author owns a given file.
- **At unit start:** `git switch -c <agent>[/<unit>]` from the latest tip → first
  commit → `git push -u origin <branch>` → `gh pr create --draft --fill`.
- **Per function:** commit (laws 1–5) → `git push` — public within minutes.
- **At unit end:** Fable (or the owner) merges to `main` with a **merge commit**
  (`gh pr merge --merge`) — never squash, never rebase — **only after confirming
  green** (the local gate passes, or the unit is verified on testnet). No green → no
  merge.
- **Abandoned experiment = closed PR.** Main stays green and clean.
- **Before submission: zero open PRs** — unmerged work is invisible to judges.

## The mechanics (the one inline thing that matters)

Commit via tmpfile — never `-m`, never backticks (the shell mangles multi-line
messages and the guard blocks it), never `--no-verify`:

```sh
printf '%s\n' '<msg>' > /tmp/cw && git commit -F /tmp/cw
```

Conventional prefixes: `feat(scope):`, `test(scope):`, `fix(scope):`, `chore:`,
`docs:`. Dependencies are installed **one at a time** — one `forge install <lib>` /
one npm package → one commit → push — never a bulk install.

## Why this is the proof

When a judge opens the history, the log itself should read as a clean, continuous,
human-grade record of production-quality open source built one deliberate move at a
time — unit by unit through reviewed pull requests, exactly how a professional team
ships. That legibility is the point: the spec ([this file] + the build order) maps
straight onto the public commits, so the *how* is auditable, not asserted.
