<!--
  PROGRESS — the build done-log (read THIS first, not the whole codebase).
  Fable + chief-of-staff keep it current so any session (and after /clear or a
  compaction) knows what's DONE without re-reading the code. One line per unit:
  agent-branch · what · green-proof (local gate / testnet-dummy) · merge sha.
  Detailed history = `git log` (per-function commits); this file is the INDEX.
  Keep done work HERE (and in git), so you only open the code when you must.
-->

# Access0x1 — build progress

## ✅ Done
- **Bootstrap** (main, commits #1–#5): `DISCIPLINE.md` → foundry scaffold (forge-std
  v1.16.1) → `.gitignore` → `CLAUDE.md` → the **256-agent `.claude` harness**. Repo
  PUBLIC + live. Branch protection live (admin-bypass). _green: forge build ✓_

## 🔄 In progress
- (awaiting relaunch at the repo root → then `proc-contracts/router-core`)

## ⏭️ Next — build order (one agent-named branch each; Fable merges on green)
`router-core` → `token-allowlist` → `payment-lanes` (6909) → `multichain`
(Arc/Base/zkSync) → `arc-gasfree` → `dynamic-agent` → `unlink-private` →
`checkout-web` → `ens-resolve` → stretches (`session-grant` 7702/6492, `cre-notify`,
`walrus-host`, `metamask-snap`) → capture → submit.

## How to use this
- A unit lands → `chief-of-staff` adds a ✅ line: **agent-branch · what · green-proof · merge sha.**
- Fable reads THIS at session start / after `/clear` instead of re-deriving state.
- Never delete a ✅ line — it's the index to what's already built.
