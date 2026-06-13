---
name: commit
description: Gate-checked, one-idea commit on the CURRENT feature branch + immediate push. The human runs this; it is never model-invoked.
disable-model-invocation: true
---

# /commit — one idea, green, pushed

Run the full commit ritual for the staged (or named) change. Refuse to proceed
if any step is red — never mask, never bypass.

1. **Branch check:** `git branch --show-current` — if `main` and `src/*.sol`
   exists, STOP: feature work goes on `feat/<unit>` (open with
   `git switch -c feat/<unit>` + `gh pr create --draft --fill`).
2. **One idea:** the staged diff is ONE function / test / fix / doc section.
   If describing it needs "and", unstage and split.
3. **Gate:** `forge build && forge test && forge fmt --check` — all green or
   stop. (The PreToolUse guard enforces this too; this step just fails fast.)
4. **Message:** intent-narrating, conventional prefix, NO backticks, via
   tmpfile only:
   `printf '%s\n' 'feat(scope): <the WHY>' > /tmp/cw && git commit -F /tmp/cw`
5. **Push immediately:** `git push` (first push of a branch:
   `git push -u origin feat/<unit>`) — cadence is measured on pushed commits.
6. Report: branch, message, gate result, pushed-or-not. One line each.
