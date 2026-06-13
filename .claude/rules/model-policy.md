# The model policy (who runs on what — and why)

Three tiers. The rule: **only Opus authors production code; Sonnet does everything that isn't code (and there is a LOT of it — lean on Sonnet hard); Fable orchestrates and red-teams.**

## Fable is the FINAL DECISION MAKER
Agents propose; **Fable decides.** On any conflict — design, cut-list, model choice, a red-team finding's severity, whether a PR is merge-ready — Fable's call is final, bounded only by the human gates: the **OWNER merges PRs**, and mainnet / money / keys need the owner. Everything below serves that.

## The tiers
- **FABLE** — the orchestrator (the main loop, the final decision maker) **+** the adversarial security red-team (`fable-redteam-*`). Fable is the sharpest model, so it gets the hardest jobs: holding the whole build in context, deciding, and *trying to break the money path*. The red-team writes **exploit tests only** (`test/attack/**`) — never `src/`.
- **OPUS** — the ONLY tier that authors or edits production code (`src/**.sol`, `web/**`, the SDK, `embed.js`, deploy scripts, config). Implementation is opus-only: `proc-contracts`, `proc-tests-invariants`, `proc-coverage`, `proc-frontend`, `proc-sdk-embed`, `proc-deploy-verify`, `foundry` (toolchain owner), `proc-snap` (MetaMask Snap), `proc-chains` (multi-chain deploy), `readme-repo` + `readme-sdk` (code-bearing READMEs — runnable snippets), `comments` (in-file comments/NatSpec — edits real files). Three surfaces: **contracts** (proc-contracts + foundry + proc-chains), **HTML/web** (proc-frontend + proc-sdk-embed), **MetaMask Snap** (proc-snap).
- **SONNET** — research, pseudocode, planning, review, docs-prose, running the gate — **never final code**. **Use Sonnet a LOT, and in parallel.** It's a separate, under-used quota: leaning on Sonnet for research keeps the Opus/Fable budget for code + breaking. Sonnet tier: every `company-*` seam advisor (13), every `role-*` (5), `proc-security-audit`, `proc-docs`, `security-reviewer`, `updraft` (Cyfrin patterns), `opsec` (secrets sentry), `marketer`, `github-page`, `erc-lab`.

## The per-unit pipeline (one feature branch, e.g. `feat/router-core`)
1. **Sonnet** (`company-*` / `role-*` / `proc-security-audit`) → research + PSEUDOCODE + tests-as-spec + the exact constants/addresses. No code. Hand the packet down.
2. **Opus** (`proc-*`) → implement the pseudocode one function per commit, gate green, push the branch.
3. **Sonnet** (`security-reviewer`) → read-only per-function review (COMMIT / FIX-FIRST).
4. **Fable** (`fable-redteam-*`) → adversarial exploit tests against the live `src/`; a break = a failing PoC handed BACK to step 2 (opus fixes).
5. **Fable** (orchestrator) → run the gate, commit, push, open the draft PR. **The OWNER merges** (merge commit, never squash).

## The code boundary (what the policy enforces)
- A **Sonnet-tier** task that tries to author/edit code (`src/`, `web/`, the SDK, scripts) is a policy violation — it hands pseudocode to an **Opus** agent instead.
- The **Fable red-team** writes ONLY under `test/attack/**`; it never touches `src/`. When it breaks something, `proc-contracts` (opus) fixes it.
- Production code = **Opus**. Exploit tests = **Fable red-team**. Standard tests = **Opus** (`proc-tests-invariants` under `test/unit|test/invariant`). Everything else = **Sonnet**.

## Why this split is right
- **Sonnet quota is "free" capacity** — research, sponsor-doc digging, pseudocode, reviews, docs, and submissions are the bulk of the work and the cheapest to run; doing them on Sonnet preserves Opus/Fable for the parts that actually need the top model.
- **Opus where correctness is load-bearing** — Solidity money paths, the SDK, the frontend: one model authoring code keeps it consistent and idiomatic.
- **Fable where it's hardest** — orchestration (whole-build context) and adversarial breaking (creative, assume-malicious). The red-team going hard at *testing* is how the money contract earns trust — they break it so attackers can't.
