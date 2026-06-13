---
name: build-loop
description: The disciplined per-function build cycle for Access0x1 — RED → GREEN → REVIEW → COMMIT on a feature branch, one idea at a time. Use for every contract/SDK function.
---

# build-loop — one function at a time, green every step, on a branch

The unit of progress is ONE function; the unit of merge is ONE branch+PR.
Run this cycle, then `/clear` and repeat.

0. **BRANCH (once per unit):** if starting a new build-order unit, open its
   branch + draft PR: `git switch -c feat/<unit>` → first commit → `git push -u
   origin feat/<unit>` → `gh pr create --draft --fill`. NEVER commit feature
   work on `main` (the guard blocks it); the OWNER merges PRs (merge commits,
   never squash — see git-workflow.md).
1. **PLAN (small):** state the single function and its signature. If it needs
   "and", it's two functions — split.
2. **RED — write the test first:** add the `forge` test for the behaviour
   (revert paths included). `forge test` should FAIL for the right reason. If the
   test must land to keep things green, commit it alone:
   `test(scope): <behaviour>`.
3. **GREEN — write the function:** minimal code to pass. `forge build` + `forge
   test` + `forge fmt` all green. (The PreToolUse gate also enforces this.)
4. **REVIEW (high-value fns):** for money paths, delegate to the
   `security-reviewer` subagent (isolated context, returns a summary) before
   committing.
5. **COMMIT (one idea, no backticks, never -m) + PUSH:**
   `printf '%s\n' 'feat(scope): <intent — the WHY>' > /tmp/cw && git commit -F /tmp/cw`
   then `git push` (every commit public on its branch within minutes).
6. **NEXT:** `/clear`, take the next function in dependency order
   (router storage + events → quote() → payToken → payNative → admin → then
   the next unit: demo token → ENS resolve → Flow → checkout web → stretch).
   At unit end: gate green → `gh pr ready` → the owner merges.

Never: batch multiple ideas, commit red, use `--no-verify`/`-m`, commit on
main post-bootstrap, squash/rebase a PR, or put a secret in code/commit.
Reuse Cyfrin patterns (MIT-headed files only, attributed): OracleLib staleness
guard, PriceConverter/HelperConfig, the handler-based invariant suite,
MockV3Aggregator, the CCIP local-simulator scripts.
