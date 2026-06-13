# RULES — git workflow (always on) — the seven commit laws + the branch flow

The public `git log` IS the product as much as the code. A judge opening the
history Sunday should watch the system grow one deliberate move at a time.

1. **One idea per commit** — one function, one test, one fix, one doc section.
   If the message needs "and", split it.
2. **Small diffs** — target ~5 lines; a coherent function may run longer, but the
   moment a diff stops fitting on a screen it's two commits.
3. **Active cadence, no batches** — commit minutes apart as work happens, and
   PUSH every commit to its public branch within minutes. Cadence is measured
   on pushed branch commits; a quiet repo (all branches) is a bug. (1inch
   disqualifies single-commit dumps.)
4. **Every commit compiles and tests green** — each step shippable. If a test
   must precede its function to stay green, the test is its own commit.
5. **Messages narrate intent** — `feat(router): quote() reads the ETH/USD feed
   with a 1h staleness guard`. No `wip`, no `fix stuff`.
6. **Public from commit #1** — feature branches are pushed immediately (a pushed
   public branch is NOT staging); no force-push anywhere, main or branches.
7. **The function is the unit of progress** — write, test, commit, next. No
   skeleton dumps of twenty empty functions.

## The branch + PR flow (professional — the owner merges)

- **Bootstrap exception:** the first commits (DISCIPLINE.md, forge scaffold,
  CLAUDE.md, .claude/ harness, deps) go DIRECTLY to `main` — an empty repo has
  nothing to review. The branch law starts with the first feature commit.
- **Branch = the AGENT's name.** Each agent works on its OWN branch named after
  it — `proc-contracts`, `chain-base`, `fable-redteam-oracle`, … (suffix the unit
  when one agent owns several: `proc-contracts/router-core`). Parallel agents =
  parallel agent-named branches in ISOLATED worktrees, no collisions; Fable
  integrates them. The build-order UNITS each agent delivers: `router-core` →
  `token-allowlist` (real tokens, NO demo) → `payment-lanes` (ERC-6909) →
  `multichain` (Arc+Base+zkSync) → `arc-gasfree` → `dynamic-agent` →
  `unlink-private` → `checkout-web` → `ens-resolve` → stretches (`session-grant`
  7702/6492, `cre-notify`, `walrus-host`, `metamask-snap`).
- **At unit start:** `git switch -c <agent>[/<unit>]` from the latest tip, first
  commit, `git push -u origin <branch>`, then `gh pr create --draft --fill`.
- **Per function:** commit (laws 1–5) → `git push` — every commit is public
  within minutes.
- **At unit end — FABLE merges to `main`** (owner's call, 2026-06-13), as a
  **MERGE COMMIT (`gh pr merge --merge`) — NEVER squash, NEVER rebase** (squash
  destroys the per-function history) — **but ONLY after confirming GREEN:** the
  local gate passes (`forge build && forge test && forge fmt --check`, or the web
  typecheck/lint/build) **OR** the unit is verified on TESTNET with dummy/test
  data. **No green → no merge.** PRs merge in dependency order. (The owner may
  also merge; Fable is authorized to merge on confirmed green.)
- **Abandoned experiment = closed PR.** Main stays green and clean.
- **Before submission: zero open PRs** — unmerged work is invisible to judges.

## No collisions — how 198 agents never step on each other
- **One branch per build UNIT (`feat/<unit>`), never one per the 198 agents.** Within
  a unit, exactly ONE opus author owns a given file — two agents never edit the same
  file at the same time.
- **Parallel agents run in ISOLATED git worktrees** (separate working copies). A
  `chain-*` researcher, a `fable-redteam-*` breaker, and a `doc-*` writer can all run
  at once without touching each other's tree; each pushes its OWN deliverable on its
  OWN branch (a breaker → `test/attack/*`, a chain → its config, a doc → its file).
- **Fable sequences the merges** in dependency order; the OWNER merges; an abandoned
  parallel branch is a closed PR.
- **The rule:** independent work → isolate (worktree + own branch, run in parallel);
  work that touches the SAME file → Fable serializes it (run one after another). That
  IS the orchestration — isolation for the independent, serialization for the shared.
- **GitHub work = `gh` + `git`** (push branches, open draft PRs) by the agents,
  orchestrated by Fable — never browser "clicking", and side-effectful repo actions
  (push/PR) are Fable/opus + the owner-merge gate, not a sonnet agent.

## Mechanics
- Commit via tmpfile, NO backticks, never `-m`:
  `printf '%s\n' '<msg>' > /tmp/cw && git commit -F /tmp/cw`.
- Never `git commit --no-verify` (a hook blocks it, and `-m`, backticks, and
  red merges too). Green gate before every commit AND every local merge.
- Conventional prefixes: `feat(scope):`, `test(scope):`, `fix(scope):`,
  `chore:`, `docs:`.
- **Deps ONE at a time** — one `forge install <lib>` → one commit → push, like a
  human; NEVER a bulk `forge install A B C`. Same for npm: one package per commit.
- **Every commit leaves every touched file + contract BEAUTIFULLY commented** —
  NatSpec on every external fn / event / custom error / storage var, JSDoc on
  every export, the WHY not the obvious. The `comments` agent runs before a
  unit's PR is marked ready.
