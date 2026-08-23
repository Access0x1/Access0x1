# Contributing to Access0x1

Thanks for looking at Access0x1 — an open-source, on-chain layer for **payments +
auth + agents**: one shared, multi-tenant `Access0x1Router` (no custody, fee-split,
Chainlink USD quotes), a `@access0x1/react` SDK, and a one-tag `embed.js`. This guide
covers how to build, test, and open a pull request so your change lands green on the
first pass.

The repo is public from commit #1 and deploys to live testnets, so the bar is
"a judge and an attacker both read every line." Everything below exists to keep that
bar clearable.

> **Security issues do not go here.** If you found a vulnerability, do **not** open a
> public issue or PR — follow the private disclosure process in
> [`SECURITY.md`](SECURITY.md).

By participating, you agree to uphold our
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — we keep this community welcoming and
review every contribution on its technical merits.

---

## For a protocol or company adapting this repo to you

**This lane exists because the integration we wrote for you is our reading of your docs, and you
know what it should have been.** If your protocol appears in the README's Partners table — or
should — you are invited to change the code, not just report it. Nothing to sign, nothing to pay,
MIT throughout.

**What you can ask for, and what happens:**

| You want | Do this | What we do |
| --- | --- | --- |
| The integration corrected | Open an issue titled `integration(<you>): …` naming the file and the right pattern | Treated as a defect, not a suggestion — a public reference teaching the wrong pattern hurts you more than us |
| To write it yourself | PR against `dev`, normal green gate | Reviewed on technical merit; you get authorship in the log |
| Us to build to your interface | Issue with a link to the spec, event shape, resolver, or rubric | We prefer implementing yours over inventing a parallel one |
| Your chain supported | Issue naming the chain + its RPC and explorer | Breadth is chosen by integrator demand; a named ask beats our guessing |
| A config seam that makes adoption trivial for your users | Describe the shape you want | Every seam is env-gated already; adding yours is usually a config file, not a rewrite |

**Two rules that will not bend, and they protect your users more than us:**

1. **Every seam stays env-gated and removable.** Blank config is a clean no-op, never a blocked
   payment. What we build for your protocol must never become a dependency your users cannot
   escape — and it means your outage is not their outage.
2. **No claim ships without its proof.** A deployed address comes from a committed broadcast
   record, a count comes from a fresh run, and `deployed` / `verified` / `usable` are three
   different words. That discipline is also what makes the reference trustworthy to cite.

**Where to start reading:** [`README.md`](README.md#partners--integrations) for the integration
table, [`docs/OPTIONAL-SEAMS.md`](docs/OPTIONAL-SEAMS.md) for how a seam is wired and disabled,
and [`FEEDBACK.md`](FEEDBACK.md) for the shape of the feedback we file upstream — the same
specificity we are asking of you.

---

## Prerequisites

- **[Foundry](https://book.getfoundry.sh/getting-started/installation)** (`forge`,
  `cast`, `anvil`) — the contract toolchain.
- **Node.js 22+** and npm — `@chainlink/contracts` resolves out of `node_modules`
  (the deprecated brownie repo is not used), and the web app / SDK are npm projects.
- **git** with submodule support — `lib/forge-std` and `lib/openzeppelin-contracts`
  are submodules.

Optional, only for the surfaces you touch: `slither` + `aderyn` (static analysis),
the `foundry-zksync` fork (`forge --zksync`), the Vyper toolchain (`mox`), the CRE
CLI. Each Make target that needs an extra tool no-ops with an install hint if it is
missing.

---

## Getting started

> New to the codebase? Skim **[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)**
> (build + run it locally in three commands) and **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
> (the money spine, so you change it with the grain) before your first PR.

```sh
git clone --recurse-submodules https://github.com/Access0x1/Access0x1.git
cd Access0x1
make install          # forge submodules + npm (@chainlink) + web deps + SDK
make build            # compile the contracts
make test             # the full Solidity suite — must be green
```

`make help` lists every target with a one-line description.

No keys, no keystore, and no `.env` are needed to build or test. Secrets are only
ever required for *deploying*, and even then they live in a `cast wallet` keystore or
`.env` (gitignored) — **never** in the repo. Copy `.env.example` (names only, never
values) to `.env` if you need to wire a deploy or a server-side feature locally.

---

## The build loop (one idea at a time)

We build in small, deliberate increments: write the function, write its test, prove
it green, commit, repeat. Each commit is **one coherent idea** (a whole function +
its NatSpec, a whole test, a focused fix) — typically 20–80 lines, not a five-line
sliver and not a twenty-function dump. If the commit message needs the word "and,"
it is two commits.

1. **Branch.** Name the branch for the work, off the latest `main` tip:
   `git switch -c <area>/<unit>` (e.g. `proc-contracts/router-core`,
   `web/checkout-headers`). Never commit a feature directly to `main`.
2. **Test first / test alongside.** Add the `forge` test (or web test) that pins the
   behavior. A test that must land first to keep the build green is its own commit.
3. **Implement** the smallest correct change.
4. **Prove it green** locally (the gate below) before you push.
5. **Commit** one idea, **push** within minutes (a public branch is the proof of
   work), and open a **draft PR**.

Never weaken or delete a passing assertion to make the gate go green — fix the code.
Update a test only when it asserted *old, now-wrong* behavior.

---

## The green gate

Run the gate that matches your surface **before every commit and before opening a
PR**. The full umbrella is:

```sh
make gate              # contracts build + test + fmt-check AND web typecheck + test
```

Or run the pieces directly:

**Contracts (`src/`, `test/`, `script/`):**

```sh
forge build            # must compile (run `make sizes` to also check EIP-170 24KB)
forge test             # full suite green  (make test)
forge fmt --check      # formatting        (run `forge fmt` / `make fmt` to fix)
forge test --match-test <name>   # a single test while iterating
```

The CI lane runs `forge fmt --check`, `forge build --sizes`, and `forge test` with
`FOUNDRY_PROFILE=ci` (the stronger 256×128 invariant profile from `foundry.toml`).
Coverage target is **≥90% lines on the money paths** (`make coverage` /
`make coverage-lcov`); the money invariants must hold under the fuzzer with
`fail_on_revert = true`.

**Fork tests** (`test/fork/**`) short-circuit to a green no-op when their RPC env var
(e.g. `BASE_SEPOLIA_RPC_URL`) is unset, so the default `forge test` stays green on a
fresh clone and in CI. Set the URL to run them live.

**Web app / SDK (`web/`, `packages/`):**

```sh
make web-gate          # embed check + typecheck + unit tests
make web-build         # production next build
make sdk-build         # typecheck the @access0x1/react SDK
```

**Before the final commit of a contract change**, run static analysis and resolve or
justify every finding (the convention is *resolve or justify*, never silently
suppress) — record dispositions in [`audit/FINDINGS.md`](audit/FINDINGS.md):

```sh
make slither
make aderyn
make analyze           # umbrella: 4naly3er + aderyn + slither
```

---

## Coding standards

- **Solidity 0.8.28, EVM cancun**, pinned in `foundry.toml` — do not change the
  compiler/EVM target in a feature PR.
- **Money paths:** `SafeERC20`, `nonReentrant` + CEI ordering on every pay path,
  custom errors (not revert strings), an event on every state change, the oracle
  staleness guard, no unbounded loops, fee-on-transfer rejection via a balance-delta
  check. Money paths roll back rather than swallow; refunds and rescues are never
  blocked.
- **SDK / client money flows** (`packages/react`): a watched on-chain event must be
  matched back to the exact payment that triggered it — the `usePayment` hook binds
  the `PaymentReceived` receipt to the payment's `orderId` so a concurrent
  same-buyer/same-merchant payment for a *different* order can't resolve the wrong
  receipt — and any wait for an on-chain event must be bounded (the receipt watch
  races a 120s timeout) rather than hanging forever. Keep these properties when you
  touch the hook, and cover them with a test.
- **No secrets, ever** — no private keys, mnemonics, RPC keys, or API keys in source,
  tests, configs, or commit messages. `.env.example` holds names only. A pre-commit
  hook blocks common secret patterns, `--no-verify`, and inline `-m`/backtick commit
  messages; if it fires, fix the leak rather than bypassing it.
- **Comments:** NatSpec on every external function / event / custom error / storage
  variable; JSDoc on every export. Document the *why*, not the obvious.
- **Formatting** is enforced — run `forge fmt` (Solidity) and the web typecheck/lint
  before committing.
- **Config is one registry entry.** Every env var the web app reads is declared in
  `web/lib/config/integrations.ts` — that one table drives `env:doctor`, the status
  probe, **and the deploy** (`web/scripts/doctor/deploy-env.mjs` derives the Cloud Run env
  from it). A var read by code but **not** declared is invisible to the doctor and is
  silently dropped at deploy, so the feature ships dark even when the operator set it.
  When you read a new `process.env.X`: (1) add it to `integrations.ts` — `secret: true`
  for a real credential (→ Secret Manager), non-secret for a flag / id / URL / selector
  (→ plain runtime env); a `NEXT_PUBLIC_` name is public, never secret; (2) add it to
  `web/.env.example`; (3) read it fail-soft (blank ⇒ `not_configured` / hidden). The
  `registry-coverage` test fails CI on an undeclared *credential* and on `.env.example`
  drift, but it can't catch a missing flag/id — so declare those by hand.
- **Production naming.** No "demo" in code or copy — it frames a shipped, testnet-live
  product as a throwaway. The hackathon pitch is the *presentation*; everything else
  uses product language. No "Phase 1/2/3" roadmap framing — name what's built and
  honestly name what isn't. Numbered wizard *steps* in a user flow are fine.

---

## Commit messages

Conventional-commit prefixes, one idea per commit, the subject narrates the *why*:

```
feat(router): quote() reads the ETH/USD feed with a 1h staleness guard
test(bookings): expireHold reverts before MIN_HOLD_SECS
fix(receiver): replace the lone string require with a ShortMetadata custom error
docs: reconcile the headline test/chain counts across README, AUDIT, FINDINGS
```

Prefixes: `feat(scope):`, `test(scope):`, `fix(scope):`, `chore:`, `docs:`. No
`wip`, no `fix stuff`. Never use `git commit --no-verify`.

---

## Pull requests

1. Push your branch and open the PR (`gh pr create --draft --fill` while in
   progress; mark it ready when the gate is green).
2. The PR description should say **what** changed and **why**, and link any issue.
3. Confirm the green gate passes for every surface you touched, and that you added or
   updated tests for the behavior you changed.
4. Keep the PR scoped to one coherent change — a diff carrying two ideas is two PRs.
5. CI (`.github/workflows/test.yml` and `audit.yml`) runs the format gate, the
   size-checked build, and the full test suite. A red CI is not mergeable.
6. PRs merge as **merge commits** in dependency order — the per-commit history is
   part of the product, so we do **not** squash or rebase, and we never force-push.

---

## Reporting bugs and proposing features

- **Bugs / features:** open a GitHub issue with steps to reproduce (for a bug) or the
  problem-and-proposed-shape (for a feature). A failing `forge test` or a minimal repo
  is the fastest path to a fix.
- **Security vulnerabilities:** **do not** open a public issue — see
  [`SECURITY.md`](SECURITY.md).

---

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE), the same license that covers this project.
