# RULES — security (always on)

Access0x1 is a no-custody payments router that is **public from commit #1** and
deploys to a live chain. Treat every commit as if a judge and an attacker both
read it. These rules are non-negotiable; a fresh session obeys them automatically.

## Secrets NEVER enter the repo
- No private keys, mnemonics, RPC keys, or API keys in source, configs, tests,
  or commit messages. Use env vars (`.env` is gitignored) + a `cast wallet`
  keystore for the deployer. `.env.example` holds NAMES only, never values.
- A PreToolUse hook blocks: secret patterns in COMMANDS (`sk-`/`sk-ant-`,
  `ghp_`, `AKIA`, `PRIVATE_KEY=`, `--private-key 0x<64-hex>`, `MNEMONIC=` with
  a value) AND in the staged/untracked FILES at commit time; `--no-verify`/`-n`;
  inline `-m`/backtick commit messages; force-push; red commits/merges; and
  feature commits on `main`. If it fires, FIX the leak — never bypass.

## ⚠️ Claude API key — Access0x1 gets its OWN, server-side only
- Access0x1 ships an **AI assistant that answers questions about the open-source
  project** (docs/checkout helper) when users are online — powered by the Claude
  API. (Reference: the `claude-api` skill.)
- **Do NOT reuse the existing Claude API key from our other live app.** That key
  belongs to a separate revenue product (a booking app with an AI concierge) with
  its own billing/limits.
  Access0x1 uses a **separate, dedicated Claude API key** (console.anthropic.com),
  so usage/cost/abuse are isolated to this project.
- **The key is SERVER-SIDE ONLY** — it lives behind a serverless proxy / API
  route, never in client code, never in the public repo, never in `embed.js`.
  Because the repo is public, a leaked key = drained billing. Proxy the Claude
  call through the backend, rate-limit it, and cap spend (mirror our other app's
  never-negative AI-meter pattern). The browser talks to OUR endpoint, which
  talks to Claude.
- Phase 0 prep: request the dedicated Access0x1 Claude API key; store it in the
  deploy env/Secrets only.

## Contract safety (judges scrutinize money paths)
- `SafeERC20`, `nonReentrant` on all pay paths, CEI ordering, custom errors,
  events on every state change, oracle freshness checks, no unbounded loops.
- Money paths roll back, never swallow; refunds are never blocked.
- Run `aderyn` + slither before the final commit; resolve or document findings.
