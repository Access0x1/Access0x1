# Access0x1 — build guide (the agent reads this first)

Access0x1 is the **open-source, on-chain layer for PAYMENTS + AUTH + AGENTS** that
any developer integrates with one link and no contract code. **Production, not a
demo** — real contracts, real settlement. Three pillars: **pay** (router,
USD-priced, no custody), **authenticate** (wallet/SIWE via the SDK), **agents**
(server-wallet signing, agent identity via ENS, agentic pay-per-call). Real
integrators consume it via ONE generic public interface — a **live booking &
commerce app** is the first real integrator, any developer next. ICP: any
company that takes payments online (booking platforms, marketplaces, SaaS
storefronts, POS, commerce apps). They are CUSTOMERS, not our brand — Access0x1
is standalone. **So every API is generic, standard, NatSpec'd, and
followable by an unaided human dev. The wedge is DX — web2-easy: drop-in SDK +
one link, no contract code, droppable in 5 minutes by any dev (even another team
at the event). Optimize every interface for that.**

ETHGlobal NY 2026 · Classic "from scratch" · public repo from commit #1.

## HOW WE WORK — operating doctrine (read first)
- **Bias to action.** If a step is clearly required and the gate is green, DO IT —
  don't ask, don't narrate options. Report tersely. Smallest correct increment,
  then the next; never sit idle. 80% sure → act and flag the 20%. Surface a
  blocker the instant you hit it, with the ONE thing you need to clear it.
- **Fill all 36 hours — finishing early means going DEEPER, not stopping.** Once
  the core is green, escalate (never idle): (1) HARDEN — `aderyn` + `slither`,
  fix/justify every finding, push coverage; (2) BREADTH — add the next sponsor
  track that's mostly framing (Chainlink CRE, ENS agent identity, a second pay
  path) — contracts are unlimited, stack them; (3) PROOF — deploy + verify,
  capture the SATURDAY-NIGHT demo, draft submissions with real tx ids; (4) POLISH
  — NatSpec, a README an unaided dev follows, the one-tag `embed.js` test.
  Idle time is forfeited prize money — there's always a higher-value next move.
- **Decide vs ask.** DECIDE (and tell the owner): next test, refactors, names,
  gas, which Cyfrin pattern, when to branch, green-gate TESTNET deploys. ASK the
  owner: merging PRs, anything on MAINNET, spending real money/keys, changing
  name/scope, the project boundary, a booth answer that changes the plan.
- **Verify or it didn't happen.** Tests prove behavior incl. revert paths; ≥95%
  router coverage; the 5 invariants hold under the fuzzer; on-chain = real address
  + tx hash; NO hard-coded values. Be honest — never claim done you can't prove.

## YOU MUST — the seven commit laws (non-negotiable)
1. ONE idea per commit (one fn / test / fix / doc). Needs "and" → split.
2. Small diffs (~5 lines; stop at one screen).
3. Active cadence — commit minutes apart, PUSH each commit to its public
   branch within minutes, never batch.
4. Every commit compiles + tests GREEN (test precedes fn if needed).
5. Messages narrate intent (the WHY); no "wip"/"fix stuff".
6. Public from commit #1 — pushed branches are public, not staging; NO
   force-push anywhere.
7. The function is the unit of progress: write → test → commit → next.
Commit via `git commit -F /tmp/cw` (NO backticks, never `-m`). Never
`--no-verify` (a PreToolUse hook blocks both + runs the gate). Use `/build-loop`.

## THE BRANCH FLOW (professional — the OWNER merges)
Bootstrap commits land on `main`; every FEATURE unit is a branch + PR:
`git switch -c feat/<unit>` → per-function commits, pushed each time →
`gh pr create --draft --fill` → gate green → `gh pr ready` → **the owner
merges with a MERGE COMMIT — never squash, never rebase** (squash collapses
the unit into a single commit and destroys the history that IS the product).
Owner unreachable >2h with a green PR → agent may `gh pr merge --merge`
(pre-authorized; owner reviews retroactively). Zero open PRs at submission.
The guard hook blocks feature commits made directly on `main`.

## THE STACK (prescribed — do not choose per-file; ambiguity kills consistency)
- Contracts: **Foundry** (not Hardhat). **Solidity 0.8.24**, EVM **cancun**.
  **OpenZeppelin 5.x** (`SafeERC20`, `Ownable2Step`), **Chainlink** contracts
  (`AggregatorV3Interface`, `CCIPReceiver`) via official deps.
- Frontend/SDK: **Next.js 15** (App Router) + TS + **Tailwind (MIT) + shadcn/ui
  (MIT)** + **viem + wagmi** (NOT ethers.js). **Dynamic SDK** = wallet auth +
  Flow + server wallets (the agent). `qrcode`; vanilla `public/embed.js`.
- AI Q&A assistant: **Claude API**, SERVER-SIDE only (see Security). Ref: the
  `claude-api` skill.
- Reuse Cyfrin patterns (MIT-headed files only, attributed in the file
  header): OracleLib staleness guard, PriceConverter/HelperConfig,
  the invariant handler, the CCIP local-simulator scripts, forge-template.

## CHAIN FACTS (fill from the booths — NEVER guess an address)
- Arc RPC: `<…>` · chain id: `5042002` (`eip155:5042002` — verified via Circle
  + Unlink docs, Jun 12) · explorer: `https://testnet.arcscan.app`
- Chainlink on Arc — ETH/USD feed: `<…>` · USDC/USD feed: `<…>` ·
  CCIP router: `<…>` · chain selector: `<…>` · ⚠️ live CCIP lane to/from Arc
  testnet: `<confirm at booth>`
- USDC (testnet): `0x3600000000000000000000000000000000000000` (USDC IS Arc's
  native gas token — system contract, verified Circle USDC-addresses page,
  Jun 12) · Gateway Wallet: `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` ·
  LINK: `<…>` · ENS: `merchant.access0x1.eth`
- GOTCHAS (record as found): Arc fee model, feed decimals (8), CCIP lane
  availability, RPC CORS.

## SECURITY (public repo + real money — judges + attackers read every commit)
- NO secrets in repo: env + `cast wallet` keystore. `.env.example` = names only.
- **Access0x1's Claude API key is SEPARATE from our other live app's, SERVER-SIDE only**
  (a Next.js API route holds it; the browser calls OUR endpoint, never Anthropic;
  never in client/`embed.js`). Rate-limit + spend-cap it.
- Contracts: `SafeERC20`, `nonReentrant` on pay paths, CEI, custom errors, events
  on every state change, **oracle staleness guard**, no unbounded loops. Money
  paths roll back, never swallow; refunds never blocked. Run `aderyn` + slither
  before the final commit.

## BUILD ORDER (dependency order — each step demoable, green every step)
1. `Access0x1Router` storage + events → `quote()` (feed + staleness guard) →
   `payToken()` (fee-split, no custody) → `payNative()` → admin. **Demoable alone
   (wins Arc + Chainlink Connect-the-World).**
2. Demo ERC-20 (token-agnostic proof) → ENS `merchant.access0x1.eth` resolution.
3. Dynamic Flow (any-token settle) + the agent on Dynamic server wallets.
4. Stretch if green: Chainlink CRE notify workflow, CCIP, Confidential AI.
5. Frontend in parallel: onboarding → hosted checkout → embed.js + QR; the
   server-side Claude Q&A endpoint.
Graceful degradation: steps 1–2 alone are a complete, judgeable product.
(The full technical spec + partner plan live with the owner; ask when needed.)

## COMMANDS (slash)
`/build-loop` (per-fn cycle) · `/chains-green` (toolchain gate) · `/deploy-arc`
(deploy + record tx) · `/sponsor-submit <Arc|Chainlink|Dynamic|ENS>` · `/capture`
(Sat-night video+deck) · `/discipline`.

## On compaction
Preserve: the modified-file list, the exact failing/pass test command, the current
function in the build order, and the unfilled chain facts above.
