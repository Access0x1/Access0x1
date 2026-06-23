# AI attribution

ETHGlobal permits AI coding tools when their use is disclosed: document **where**
and **how** AI was used, keep the **planning artifacts in the repo** so judges see
how the AI was directed (not just its output), and make clear that **AI assisted —
humans drove the decisions**. This file is that disclosure. Spec-driven proof lives
in [`specs/`](./specs); the build-time proof is the public, one-idea-at-a-time
[`git log`](https://github.com/Access0x1/Access0x1/commits/main).

## The one-line version

Access0x1 was built with **Claude Code** (Anthropic's CLI) running a multi-agent
harness. The **AI wrote the code and tests under a strict, owner-defined
discipline**; the **owner (a human) made every decision that mattered** — scope,
architecture, the security bar, what merges, and every on-chain / money / key
action. The agents are an accelerant, not the author of the project.

## The tool

- **Claude Code** — Anthropic's official CLI, the only AI tool used to author this
  repo. No other code-generation tool was used.
- **A multi-agent harness**, checked into the repo at [`.claude/`](./.claude)
  (rules, hooks, skills, agent roster). It is part of the submission on purpose —
  it shows *how* the AI was directed, which is exactly what the rules ask for.
- **A server-side Claude API** is also a runtime *feature* of the product (the
  "Ask Access0x1" Q&A assistant) — that is a shipped capability, separate from the
  build-time tooling described here. It runs behind a backend route with its own
  spend-capped key; the key is never in the repo (see
  [`.claude/rules/security.md`](./.claude/rules/security.md)).

## The model policy — who did what

A three-tier split, defined once in
[`.claude/rules/model-policy.md`](./.claude/rules/model-policy.md) and enforced
across the build:

| Tier | Role | Touched |
| --- | --- | --- |
| **Opus** | Authored / edited all production code | `src/**.sol`, `web/**`, the SDK, `embed.js`, deploy scripts, config, standard tests |
| **Sonnet** | Research, pseudocode, planning, prose, review, running the gate | docs, integration research, reviews — **never final code** |
| **Fable** (orchestrator) | Held the whole build in context, decided, and **red-teamed the money path** | adversarial exploit tests under `test/attack/**` — **never `src/`** |

The rule, verbatim from the policy: *only Opus authors production code; Sonnet does
everything that isn't code; Fable orchestrates and red-teams.* The per-unit pipeline
was: **Sonnet researches + writes pseudocode → Opus implements one function per
commit → Sonnet reviews → Fable red-teams the live `src/` → the owner merges.**

## How the AI was used, by surface

Effectively the whole repo was AI-assisted under this discipline — that is the
honest claim, not a list of carve-outs. Concretely:

- **Contracts** (`src/**.sol`) — the first-party surface (21 contracts: the money
  spine `Access0x1Router` + `OracleLib`, `PaymentLanes`, `SessionGrant`; the
  multichain + price sidecars `ChainRegistry`, `PriceOracleAdapter`,
  `Access0x1Receiver`, `AutomationGateway`, `GaslessPayIn`; the
  `HouseToken`/`HouseTokenFactory` pair; `NameMath`; the on-chain
  `Access0x1ProvenanceRegistry`; and the commerce set
  `Subscriptions`/`Bookings`/`Invoices`/`GiftCards`/`Nft`/`Escrow`/`Refunds`/`Receivables`/`SplitSettler`)
  was authored by the Opus tier from Sonnet-authored pseudocode, one function per
  commit.
- **Tests** (`test/**`) — unit, invariant, and integration tests were authored by
  Opus; the **adversarial exploit tests under `test/attack/**` were written by the
  Fable red-team** to try to break the money path (a break = a failing PoC handed
  back to Opus to fix). Reused MIT Cyfrin/Updraft patterns are attributed in their
  file headers.
- **Frontend / SDK / embed** (`web/**`, `packages/react/**`, `web/public/embed.js`)
  — the Next.js checkout + dashboard, the `@access0x1/react` SDK, and the one-tag
  embed were authored by Opus. The same review-then-harden loop applies here: e.g.
  the `usePayment` hook was tightened so the watched `PaymentReceived` receipt is
  bound to the payment's `orderId` (a concurrent same-buyer/same-merchant payment
  for a different order can't resolve the wrong receipt) and the receipt watch races
  a 120-second timeout instead of hanging forever.
- **MetaMask Snap** (`snap/**`) — authored by Opus.
- **Deploy + CI** (`script/**`, `Makefile`, `.github/**`) — authored by Opus.
- **Docs** (`README.md`, `PROGRESS.md`, `audit/**`, this file, `specs/**`) — prose
  drafted by the Sonnet tier; code-bearing docs (runnable snippets, NatSpec) by
  Opus.
- **Reused, NOT AI-authored here** — third-party dependencies are vendored, not
  generated: OpenZeppelin 5.6.1, Chainlink contracts 1.5.0, forge-std, and the
  MIT Cyfrin/Updraft patterns (`OracleLib` staleness guard, `HelperConfig`/price
  converter, the invariant handler, `MockV3Aggregator`, the CCIP local simulator).
  All are attributed in headers and listed in
  [`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md).

## What the human (owner) drove — the AI did NOT decide these

The discipline reserves the genuine gates for the owner; the agents never crossed
them (see the "decide vs ask" rule in [`CLAUDE.md`](./CLAUDE.md) §6 and
[`.claude/rules/accounts.md`](./.claude/rules/accounts.md)):

- **Scope and architecture** — the product idea (one shared no-custody router, the
  O(1) hash-map chain registry, ERC-6909 PaymentLanes), the chains, and the integration
  targets were the owner's calls.
- **The merge gate** — the owner reviews and merges PRs to `main`; every one of the
  164 merged PRs is the owner's decision. Main is only ever merged on a green gate.
- **Everything on-chain or costing money** — mainnet, real keys, spending, and the
  final tap on any account signup are owner-only. Agents prepare a signup and open
  the page; the owner taps "Create / I agree." No agent ever accepted terms or
  created credentials.
- **The security bar** — the owner set the floor (high router coverage — ~98% lines,
  100% functions, against a documented 90%-on-money-paths minimum — the fuzz
  invariants, aderyn + slither triaged clean or documented) that the AI had to clear.

## Build-time proof — the git log

The strongest evidence of *how* this was built is the public history itself, which
the discipline ([`.claude/rules/git-workflow.md`](./.claude/rules/git-workflow.md))
makes legible:

- **One idea per commit**, ~20–80 lines, messages that narrate intent — so the log
  reads as a time-lapse of the system growing, function by function.
- **One branch per build unit**, pushed publicly within minutes, landed as a
  **merge-commit PR** the owner merged (never squash/rebase — squashing would
  destroy the per-function history that is part of the product).
- **561 commits across 164 merged PRs** at the time of writing, public from
  commit #1.

### Commit authorship — the honest detail

- The **bootstrap + early-doctrine commits** (the build discipline, the Foundry
  scaffold, the `.gitignore`, the project guide, the 256-agent `.claude/` harness,
  and the doctrine docs — **11 commits**) carry a
  `Co-Authored-By: Claude Fable 5` trailer. These are the scaffolding commits that
  set up the repo and its rules.
- **Every feature, test, and fix commit from the dependency installs onward** (the
  remaining commits, including all of `src/`, the web app, the SDK, and the tests)
  is **authored solely as the owner** — per the project's commit law, which is that
  the human owns the committed work. So the AI-co-authored trailer marks the harness
  setup, not the product code.

This is disclosed deliberately rather than scrubbed: judges can verify it with
`git log --format='%an %s' | head` and by inspecting the message bodies of the
first dozen commits.

## Verifying these claims

```sh
# the harness that directed the AI (in the repo on purpose)
ls .claude/rules .claude/hooks .claude/skills

# the spec-driven trail
ls specs/

# the one-idea-at-a-time history
git log --oneline | head -40

# the 11 co-authored bootstrap commits vs. the owner-authored build
git log --format='%H %s %b' | grep -i 'co-authored-by'
```

Anything this file claims that the repo does not bear out is a bug — report it.
The standard the build held itself to: *never claim done you cannot prove.*
