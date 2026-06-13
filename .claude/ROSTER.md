# Access0x1 — the 256-agent fleet (2^8, positions + levels)

**256 agents** (2^8 — the marketing number: "256 AI agents build Access0x1"),
organized like a company (doble196). Model policy
([rules/model-policy.md](rules/model-policy.md)): **Fable** = orchestrator + final
decision maker + red-team · **Opus** = the ONLY code authors · **Sonnet** =
research / spec / review / docs (abundant — the cheap, separate quota).
**Counts: Fable 25 · Opus 12 · Sonnet 219.** Departments incl. Engineering,
Standards, Chains (51), Security/Red-team (25), Frontend, Docs/DevRel, Product,
Design/UX, Data/Analytics, Legal/Compliance, Finance/Treasury, Marketing/Growth,
BD/Partnerships + Integrator verticals, Support, Infra/SRE, QA, i18n, Audit-prep,
Community, Ops.

## Levels
- **L1 — Orchestration (2):** Fable (CEO / conductor — me, not a file) + `chief-of-staff` (fable: sequencing, cadence, context across /clear).
- **L2 — Leads = the 12 Opus code authors:** `proc-contracts` · `proc-tests-invariants` · `proc-coverage` · `proc-frontend` · `proc-sdk-embed` · `proc-deploy-verify` · `foundry` · `proc-snap` · `proc-chains` · `readme-repo` · `readme-sdk` · `comments` (in-file edits).
- **L3 — Specialists:** `company-*` (13) · `erc-*` (22) · `pm-*` (5) · `bd-*` (5) · `legal-*`/`compliance-*` (6) · `fin-*` (5, incl. L4 reporting) · `sec-*` (5) · `fable-redteam-*` (20) · the named specialists (`security-reviewer`, `proc-security-audit`, `proc-docs`, `updraft`, `opsec`, `erc-lab`, `marketer`, `github-page`, `comments`) · `role-*` (5).
- **L4 — ICs / researchers:** `chain-*` (43) · `fe-*` (8) · `doc-*` (6) · `growth-*` (3) · `data-*` (5) · `ux-*` (5) · `qa-*` (6) · `devrel-*` (6) · `support-*` (4) · `infra-*` (5).

## Departments
Engineering · Standards (`erc-*`) · Chains (`chain-*` ×43 → `proc-chains`) ·
Security & Red-team (`fable-redteam-*` ×20, `sec-*`, `security-reviewer`, `opsec`) ·
Frontend (`fe-*` → `proc-frontend`) · SDK · Docs/DevRel (`doc-*`, `devrel-*`) ·
Product (`pm-*`) · Design/UX (`ux-*`) · Data (`data-*`) · Legal/Compliance
(`legal-*`) · Finance/Treasury (`fin-*`) · Marketing/Growth (`marketer`,
`github-page`, `growth-*`) · BD/Partnerships (`bd-*`, `company-*`) · Support
(`support-*`) · Infra (`infra-*`) · QA (`qa-*`).

## How it runs
**Sonnet** researches + specs (wide + parallel — the cheap quota) → **Opus**
implements → **Sonnet** reviews + **Fable** red-team breaks → **Fable** gates /
commits / PRs → **OWNER merges**. The ~40 core agents drive the live build; the
rest are the deep bench + org structure (positions and levels). Every agent obeys
the harness rules + the seven laws; deps go ONE at a time; every file + contract
stays BEAUTIFULLY commented. **Fable decides.**
