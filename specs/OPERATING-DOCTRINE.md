# Spec: the operating doctrine

The brief every unit of Access0x1 was built against. This is the spec the AI agents
were handed; the live, auto-loading copy is [`../CLAUDE.md`](../CLAUDE.md) and the
always-on [`../.claude/rules/`](../.claude/rules). Captured here so the spec ships
with the submission.

## What is being built

ONE open-source, on-chain layer for **payments + auth + agents**:

- `Access0x1Router` — USD-priced via a Chainlink feed read **inside the pay tx**,
  fee-split, **zero custody**.
- A `@access0x1/react` SDK + a one-tag vanilla `embed.js`.
- Deployed across **Arc + Base + zkSync** testnets via **one shared router** (not
  N deploys), addressed by an **O(1) hash-map chain registry**.
- Web2-easy DX: drop-in SDK, one link, no contract code — droppable in five minutes
  by any developer. Integrators are customers reached through one public interface.

## The WOW mandate — four axes, all four or it isn't done

- **Logic** — the architecture is so clean a judge says *"of course."* One shared
  router, a hash-map chain registry, ERC-6909 PaymentLanes, no custody, a valid ERC
  nobody else ships (6909 / 7702 / 6492). The idea wins before a line of code does.
- **Presentation** — the README is the gold standard; the demo is a 2-minute
  jaw-drop; one diagram tells the whole story.
- **Delivery** — it **runs**: live testnet, real tx hashes, an agent paying real
  USDC on three chains. No "imagine if," no hard-coded values.
- **Code efficiency** — gas-tight (packed structs, one SLOAD on the hot path,
  cached lengths, `unchecked` where proven safe, custom errors, immutables) and DRY
  (one `_settle` core, one chains map, one identity system).

"Good enough" is a loss.

## The laws (unbreakable)

- **One idea per commit** — a whole function + NatSpec, a whole test, or a focused
  fix; typically 20–80 lines. Commit via tmpfile only
  (`printf '%s\n' '<msg>' > /tmp/cw && git commit -F /tmp/cw`) — never `-m`, never
  backticks, never `--no-verify`.
- **Green at every merge to main** — the full gate (`forge build && forge test &&
  forge fmt --check`, or web typecheck+lint+build) passes before any merge; main is
  always green. On an agent branch, commit freely and frequently — RED-while-building
  is fine; the cadence is the proof.
- **Branch = the agent's name**, pushed publicly within minutes; no force-push ever.
- **Fable merges to `main` only on confirmed green**, as a **merge commit** — never
  squash, never rebase (squashing destroys the per-function history).
- **No secret ever** in code / commit / logs — env + `cast wallet` keystore only;
  `.env.example` holds names, not values.
- **Testnet only during the event** (Arc / Base / zkSync); mainnet is owner-run,
  post-audit, never mid-build.
- **Money paths roll back, never swallow** — refunds never blocked, no custody,
  CEI + `nonReentrant` + oracle-staleness on every pay path; the fuzz invariants are
  the floor, not the ceiling.

## Verify or it didn't happen

- Tests prove behavior including every revert path; **≥95% router coverage**; the
  invariants hold under the fuzzer.
- On-chain = the real address + tx hash, recorded per chain. No hard-coded values.
- Be honest: a tool isn't clean → say so; untested → say so. Never claim done you
  cannot prove — a judge will run it.

## Decide vs ask — the human gates

- **The AI decides (and reports):** the next test, refactors, names, gas choices,
  which pattern, when to branch, green-gate testnet deploys, and merging green PRs.
- **The owner (human) is asked:** anything on mainnet, spending real money/keys,
  changing the name/scope, and the final tap on any account signup (agents pre-fill
  and open the page; the owner taps "Create / I agree" — agents never accept terms
  or create credentials).

This gate is why the project is AI-assisted, not AI-authored: the decisions that
carry money, identity, or scope are the human's.

## The stack (prescribed — ambiguity kills consistency)

- **Contracts:** Foundry · Solidity 0.8.28 (EVM cancun) · OpenZeppelin 5.6.1 ·
  Chainlink contracts 1.5.0. Reused Cyfrin/Updraft MIT patterns attributed in
  headers.
- **Frontend / SDK:** Next.js 16 + React 19 + Tailwind v4 + shadcn/ui · viem 2.x +
  wagmi 3 (not ethers) · Dynamic SDK 4.x.
- **AI Q&A feature:** the Claude API, server-side only, with its own spend-capped
  key — never in the browser, `embed.js`, or the repo.

Full, enforced detail: [`../.claude/rules/stack.md`](../.claude/rules/stack.md) and
[`../.claude/rules/security.md`](../.claude/rules/security.md).
