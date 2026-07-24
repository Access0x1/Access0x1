# Access0x1 — Truthful Self-Audit

> **Our north star: testnet today, and we say so.** This document states exactly what is
> deployed, tested, and verifiable — and exactly what is a seam, what is not built, and what
> is not yet on mainnet. Every claim here is reproducible from this repo. If it isn't proven,
> we don't claim it.

_Last updated: 2026-07-24 (test-count refresh: 2,026 Foundry contract tests + 1,792 web/SDK unit tests; nine-chain mirror incl. zkSync Sepolia 300)._

---

## 1. Deployed & verified — the hard proof

**One mirrored address set, live on NINE testnets.** Access0x1 deploys via CREATE3 (the
[CreateX](https://github.com/pcaversaccio/createx) factory), so every contract carries the **same
address on every chain the mirror is live on** — the `Access0x1Router` proxy an integrator points at is
[`0xe92244e3368561faf21648146511DeDE3a475EB5`](https://sepolia.basescan.org/address/0xe92244e3368561faf21648146511DeDE3a475EB5)
**on all nine**: Arc (5042002), Base Sepolia (84532), Ethereum Sepolia (11155111), Optimism Sepolia
(11155420), Avalanche Fuji (43113), Robinhood Chain (46630), Arbitrum Sepolia (421614), Celo Sepolia
(11142220), and zkSync Sepolia (300). The mirror is **source-verified on seven** of them (Avalanche
Fuji and zkSync Sepolia deployed, verification pending). Three earlier chains (Ethereum Hoodi
560048, 0G Galileo 16602, Tempo Moderato 42431) carry **pre-mirror, per-chain** deploys at the older
address and are being cut over. Every address is read from a committed `broadcast/DeployAll.s.sol/<chainId>/`
record (law #4 — an address that isn't on-chain isn't claimed) and self-checked against
[`script/mirror-manifest.json`](script/mirror-manifest.json); the full per-chain table is in the
[README](README.md#deployments).

- The canonical mirror set (each proxy's implementation pinned under its `.impl` key in the manifest) is
  the single source of truth for addresses — **never** hand-entered. `make sync` regenerates the
  `MIRROR-STATUS` table in the README straight from the broadcast records.
- On each mirrored chain the whole first-party surface deploys **wired together in a single broadcast**
  (`make deploy-<chain>`), every receipt status `0x1`, commit-pinned. On **Arc Testnet** gas is paid in
  **native USDC**.
- **A merchant is registered on-chain** permissionlessly via `registerMerchant` with its own payout
  wallet, fee config, and name hash — the merchant registry is the single source of truth every commerce
  primitive reads for owner-authorization.
- **`bytecode_hash = "none"`** in `foundry.toml` makes the build reproducible byte-for-byte; the
  deployed-runtime-equals-this-source attestation is in [`audit/DEPLOYED-CODE.md`](audit/DEPLOYED-CODE.md)
  (a reproducible `cast code` vs `forge inspect deployedBytecode` diff, independent of the explorer badge).

**zkSync Sepolia** required its dedicated EraVM path (zksolc from a clean root) and is DEPLOYED at the
SAME mirror address `0xe92244e3…`, confirmed in `broadcast/…/300` — see `docs/ZKSYNC-TESTING.md`. More
EVM chains (Polygon Amoy, Scroll Sepolia, …) are per-chain ready (`make deploy-<chain>`) but not yet broadcast.

---

## 2. Tested

- **2,026 contract tests, 0 failed, 0 skipped** (`make test`; the count is CI-enforced against `forge test --list`
  by `scripts/sync-test-badge.mjs`). The 3 `test/fork/**` Chainlink-feed tests are
  counted in the total and short-circuit to a green no-op when no fork RPC is set, so a fresh clone and CI
  both run green; set `BASE_SEPOLIA_RPC_URL` to exercise them against the live feed.
- **The web + SDK suites** (Vitest) cover `@access0x1/react` and the Next.js money-adjacent routes. A
  recent SDK hardening pass tightened the `usePayment` receipt watch — see §3 (it ships with its own
  `usePayment-timeout.test.ts`).
- **The money-safety fuzz invariants hold under `fail_on_revert = true`** (a swallowed error counts as a
  failure). The router's six are the floor — native conservation, token conservation, platform cut always
  to treasury, zero-custody residual, merchant isolation, and effective fee ≤ `MAX_FEE_BPS` — joined by the
  PaymentLanes per-asset conservation/firewall set and per-lifecycle invariants on the commerce primitives
  (escrow always backed, fee never exceeds escrow, settle-at-most-once, budget never past cap, card
  conservation). Fuzzed at 4,096 calls each per target locally (default `runs=64 × depth=64`), more in CI
  under `FOUNDRY_PROFILE=ci` (`runs=256 × depth=128` from `foundry.toml`; set in `.github/workflows/*.yml`).
- **Symbolic proofs** (Halmos, `make halmos`, `test/symbolic/`): fee-split value-conservation
  (`FeeSplitSymbolic`) and the SessionGrant spend-never-exceeds-budget meter (`SessionBudgetSymbolic`).
- **Coverage (run `forge coverage --ir-minimum`):** 100% functions on the router; ~98% lines, ~97% branches
  (per-contract table in [`audit/COVERAGE.md`](audit/COVERAGE.md) / [`audit/FINDINGS.md`](audit/FINDINGS.md)).
  The number in the README badge is whatever `forge coverage` actually prints — never inflated.
- **Static analysis:** Slither — every result triaged (false-positive / by-design / justified-with-runtime-guard),
  **0 exploitable**; Aderyn — every High/Low triaged. Dispositions are recorded per-instance in
  [`audit/FINDINGS.md`](audit/FINDINGS.md). We record the analyser counts honestly and do not claim a clean
  bill beyond what the tracker shows.
- **Local end-to-end proof, no keys:** `make anvil` + `make deploy-local` + `make drive-local` runs a
  real payment and prints `net+fee==gross: true` and `router USDC bal: 0`.

---

## 3. Security posture

- **Non-custodial by construction.** Settlement is atomic (pull → split → push) in one tx; the router's
  steady-state balance is zero. The only native it can hold is value owed back via `claimRescue` when a
  payee contract rejects a push — the receipt still stands, funds are never stuck. A fuzz invariant
  enforces the zero residual.
- **Four money laws, enforced in code:** a payment rolls back or settles (never silently swallows);
  a refund can never be blocked; every value-moving external is `nonReentrant` and follows checks-
  effects-interactions; the contract never holds merchant funds.
- **Oracle safety:** `quote()` reads the Chainlink feed in-transaction through `OracleLib`
  (1-hour staleness + completed-round guard); a stale feed reverts the payment closed, never settles
  against a bad price.
- **L2 oracle safety:** `OracleLib.checkSequencerUp` adds Chainlink's L2 Sequencer-Uptime guard — the
  router reads it in `quote()` **only when an uptime feed is wired** (an owner setter; unset on L1 / Arc,
  the default, where behaviour is byte-for-byte unchanged). A down or just-restarted sequencer reverts the
  quote rather than settling against a feed that is "fresh" but stands behind a sequencer that just came back.
- **Findings self-caught and fixed during the build:** the SessionGrant ERC-6492-prepare reentrancy
  double-open (the `_open` nonce is now pinned to the validated nonce — see §7.1 in
  [`audit/REPORT.md`](audit/REPORT.md)); the Bookings stale-oracle refund-block (resolution fee leg made
  oracle-fault-tolerant so a dead feed refunds the full escrow, never bricks it); and the web `/api/quote`
  input-validation bypass (a negative/zero/NaN price can never be quoted). Each carries its own regression
  tests; no existing test was weakened.
- **Conduit + gasless + ERC-6909 hardening (this update, all merged to `main`):** the `PaymentLanes`
  conduits (`SplitSettler` / `Receivables`) now **claim the settled net back** from their lane so a
  downstream failure can never strand funds (#203); `GaslessPayIn`'s zero-custody assertion is a **delta
  vs the pre-pull baseline**, not an absolute-zero check, so a pre-existing dust balance can't false-trip
  it (#204); `PaymentLanes` now **conforms to ERC-6909** — canonical `Transfer` topics + a mandatory
  `supportsInterface` (#205); and the **lone `unchecked` block on the `PaymentLanes` value path was
  removed** so every money-path arithmetic is checked (#207). Each fix ships with its own regression
  tests inside the whole-suite total; no existing test was weakened.
- **SDK receipt-binding hardening (`@access0x1/react` `usePayment`):** the watched `PaymentReceived`
  receipt is now bound to the payment's `orderId` — the on-chain event filter only matches the indexed
  `{merchantId, buyer}`, so a concurrent payment by the same buyer to the same merchant for a **different**
  order (e.g. a second checkout tab) could otherwise resolve the hook with the wrong receipt. The watch is
  also raced against a **120s timeout** so a missing or undecodable event fails loud instead of hanging the
  pay flow forever (the watcher is torn down either way). Covered by `usePayment-timeout.test.ts`.
- **Honest limitation:** **no third-party audit yet.** Mainnet is blocked in code behind
  `MAINNET_AUDITED=yes` — that gate is deliberate and protects users until an external audit lands.
- Secrets are env-only; signing is keystore-only (`--account`, never `--private-key`). No hardcoded
  contract addresses in the deploy path.

---

## 4. Integration ledger — what's real

**Shipped (in code, working, verifiable):**
- **Dynamic** — the embedded-wallet layer; every connect/sign/pay/register runs through it.
- **Chainlink** — USD Data Feed read inside every settlement tx; staleness-guarded.
- **ENS** — gasless merchant subnames via Namestone + ENSIP-11 (coinType) / ENSIP-19 (verified primary name).
  Plus the **ENSv2 Payment Resolver** (`src/ens/Access0x1PaymentResolver.sol` + `web/lib/ens/ensv2.ts` +
  `web/app/api/ens/resolve`, unit-tested): a custom resolver that resolves `pay.<merchant>.eth` to the
  merchant's LIVE router payout/config at query time. The signed EIP-3668 CCIP-Read wrapper is a declared
  next rung, NOT claimed live (the on-chain resolver is the source of truth); the ENSv2 registry addresses
  are alpha/env-gated, blank ⇒ the ENSv1 path.
- **World ID** — one-tap proof-of-personhood gate; nullifier dedup with replay protection; a Casino-Verified
  vertical that makes the gate mandatory for gaming merchants. (World ID proves a unique human only —
  not age, jurisdiction, or a gambling licence; we state that in-product.)
- **Circle x402 / Gateway** — USDC settlement via EIP-3009, gasless for the payer (the facilitator batches
  and pays gas). **This is x402/Gateway, NOT CCTP** — there is zero burn-and-mint code in this repo.
- **OIDC/JWT identity layer**, **MetaMask Snap** (payment insight in the signing dialog), **`@access0x1/react`
  SDK** (drop-in `<PayButton>` + the `usePayment` hook — orderId-bound receipt watch with a 120s timeout
  ceiling; Vitest-covered; git-distributed — consumed as a GitHub dependency, not published to npm by design), and the `create-access0x1` scaffolder.

- **Uniswap v4 hook** — `src/uniswap/Access0x1SwapReceiptHook.sol` (+ 6-test unit suite): an
  afterSwap-only hook that emits an attributable on-chain SwapReceipt (merchantId + orderRef via
  hookData) for merchant payout swaps — zero custody, zero fee, the other nine callbacks revert.
  Built + unit-tested; NOT deployed (a live deploy needs the CREATE2 address-mining step so the
  address carries the AFTER_SWAP flag — claimed only when a broadcast record exists).

**Seam (code present, NOT exercised in the live example path / booth-SDK-gated):**
- **Walrus** (decentralized storage), **Unlink** (private payout), **Blink** (one-tap funding),
  **Uniswap payout-swap** (receive-in-any-token rail), **1inch** (aggregator payout-swap rail
  `web/lib/payout-swap/rails/oneInch.ts` + agent pay-any-token quote `web/lib/agent/anyToken1inch.ts`,
  both unit-tested, env-gated + dormant until `ONEINCH_API_URL`, zero integrator fee),
  **paymaster** (gas sponsorship). We label these as seams everywhere — never as "live."
- **0G Compute** — agent inference on 0G's decentralized compute (`web/lib/ai/inference.ts` +
  `web/lib/ai/agentInference.ts`, unit-tested): `AI_INFERENCE_PROVIDER=zerog` routes `/api/ai/infer`
  and the docs assistant to 0G instead of Anthropic. Two modes — a static-key gateway and a native
  **broker** (funded operator wallet mints signed per-request billing headers, verified against
  `@0gfoundation/0g-compute-ts-sdk` 0.9.0). Env-gated + dormant until configured; the SDK is an
  optional peer, install-on-opt-in. (0G *chain* 16602 is separately deployed — see the deploy tables.)
- **0G / agent earn→store→own** — `web/lib/agent/stateAnchor.ts` anchors a settled receipt's hash on
  the ProvenanceRegistry after storing the blob on **Walrus** (not 0G Storage). Dormant unless
  `AGENT_STATE_ANCHOR=true`; the anchor leg is testnet-allowlisted. Honest outcome states
  (`stored`/`anchored`) — never a claimed anchor without a mined tx.

**Not built — we do NOT claim these:**
- LI.FI, Canton, Ledger, Google Cloud / BigQuery, Privy, CCTP, ERC-5570 / ERC-5192 / ERC-1155,
  and cbBTC is **not** in the live `SUPPORTED_PAY_TOKENS` list. (Hedera moves to a deployed chain and
  1inch to a seam as those land — see the deploy tables / the Built-on list.)

---

## 5. Economics & scope

- **Platform fee = 1%** (`platformFeeBps = 100`) on this deployment. It is set **once in the constructor
  and is immutable on a deployed router** (no setter) — capped at `MAX_FEE_BPS` (10%). A different rate
  (e.g. 2%) is a deploy-time parameter on a fresh deployment, not a change to the live one.
- **Testnet only. No mainnet deployments and no mainnet claims.**

---

## 6. Verify it yourself

```bash
git clone https://github.com/Access0x1/Access0x1 && cd Access0x1
make test                       # 2,026 contract tests, 0 failed
forge coverage --ir-minimum     # the real coverage number
make halmos                     # the symbolic fee-split + budget proofs
make anvil && make deploy-local && make drive-local   # real local payment, no keys
```
Then open the verified router on any mirrored chain's explorer (links in the README Deployments table —
the same `0xe92244e3…` address everywhere) and inspect the on-chain merchant registration + payment
events directly.

---

*This audit is intentionally public. We would rather you catch a gap here than be surprised on stage.
Everything claimed is reproducible from this repository; everything unfinished is labeled as such.*
