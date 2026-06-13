## The Access0x1 build discipline — how the fable agent writes open source

Access0x1 is built by a modern professional agent that works the way the best
human developers work — and leaves the history to prove it. These rules are not
style preferences; they are the law of the repo, and the commit log is the
product as much as the code is. Anyone reading `git log` should be able to
watch the system grow decision by decision, like a time-lapse of craftsmanship.

1. **One idea per commit.** A commit adds one function, one test, one fix, or
   one document section — never two of those things at once. If the message
   needs the word "and", split it.
2. **Small diffs, always.** Target ~5 lines per commit; a single coherent
   function may run longer, but the moment a diff stops fitting on one screen
   it is two commits pretending to be one.
3. **Active cadence, no batches.** Commit as the work happens — minutes apart,
   not hours — and **push every commit to its public branch within minutes**.
   Cadence is measured on pushed branch commits, not on main: code is never
   stockpiled locally and dumped, and a quiet REPO (all branches) during the
   hacking window is a bug. (1inch disqualifies single-commit entries
   outright; ETHGlobal judges build-time work. The cadence IS the proof.)
4. **Every commit compiles and tests green.** Each step is shippable on its
   own. If a test must precede the function to keep things green, the test is
   its own commit, marked as such.
5. **Messages narrate intent, not mechanics.** `feat(router): quote() reads
   the ETH/USD feed with a 1h staleness guard` — a reviewer learns the WHY
   from the subject line alone. No `wip`, no `fix stuff`, ever.
6. **Public from commit #1.** The repo is open source from the first line —
   feature branches are pushed to the PUBLIC repo immediately, so a pushed
   branch is not private staging. No force-push anywhere, ever — not main,
   not branches. What the judges see is what happened.
7. **The function is the unit of progress.** Build one function at a time:
   write it, test it, commit it, then start the next. No skeleton dumps of
   twenty empty functions to "fill in later".

## The branch flow (how the laws run in practice — professional, reviewable)

- **Bootstrap goes straight to main:** the first commits (discipline, scaffold,
  project guide, harness, deps) land directly on `main` — an empty repo has
  nothing to review. The branch flow starts with the first feature commit.
- **One branch per unit of the build order** (`feat/router-core`,
  `feat/demo-token`, `feat/ens-resolve`, …) — never one branch per function.
  The per-function commits (laws 1–5) happen ON the branch, pushed after every
  commit.
- **Every unit lands as a PULL REQUEST the owner merges** — with a **MERGE
  COMMIT, never squash, never rebase**. Squash would collapse the unit into
  one commit and destroy the per-function history that IS the product.
- **An abandoned experiment is a closed PR** — main stays clean and green.
- **Owner-unreachable fallback (pre-authorized):** if a PR has sat green and
  unmerged for over 2 hours and the owner is unreachable, the agent may
  `gh pr merge --merge` it (owner reviews retroactively); the next unit
  branches off the unmerged tip meanwhile, and PRs merge in order.
- **Zero open PRs at submission** — unmerged work is invisible to judges.

The aim is simple: when a sponsor judge opens the history Sunday morning, the
log itself should wow — a clean, continuous, human-grade record of an agent
building production-quality open source one deliberate move at a time, unit
by unit through reviewed pull requests, exactly how a professional team ships.

