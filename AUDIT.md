# Access0x1 — Truthful Self-Audit

> **Our north star: testnet today, and we say so.** This document states exactly what is
> deployed, tested, and verifiable — and exactly what is a seam, what is not built, and what
> is not yet on mainnet. Every claim here is reproducible from this repo. If it isn't proven,
> we don't claim it.

_Last updated: 2026-06-14 (ETHGlobal NY)._

---

## 1. Deployed & verified — the hard proof

**Deployed on SEVEN testnets — Arc (5042002), Base Sepolia (84532), Ethereum Sepolia (11155111),
Optimism Sepolia (11155420), Avalanche Fuji (43113), Robinhood Chain (46630), and Ethereum Hoodi
(560048) — and source-verified on TWO of them: Base Sepolia (84532) and Arc Testnet (5042002, Circle).**
Every address is read from a committed `broadcast/DeployAll.s.sol/<chainId>/` record (law #4 — an address
that isn't on-chain isn't claimed); the full table is in the [README](README.md#deployments). On Base
Sepolia the full money + commerce surface is deployed and wired in a **single broadcast, 13 transactions,
every receipt status `0x1`**, commit-pinned, verified on Blockscout. On **Arc Testnet** all 8 contracts +
the USD feed are deployed and **verified on arcscan**, with gas paid in **native USDC** — Router
[`0xA5982ea8842Eea97C6e313A5f75FD8CF72C69Aad`](https://testnet.arcscan.app/address/0xa5982ea8842eea97c6e313a5f75fd8cf72c69aad).

| Contract | Address |
|---|---|
| Access0x1Router | [`0xec89c9eE28AF42Ae2b917BB0bAe245EAad6E8E57`](https://base-sepolia.blockscout.com/address/0xec89c9eE28AF42Ae2b917BB0bAe245EAad6E8E57) |
| SessionGrant | `0xf5d9eefb2e3abbfb9ae2b4e6a26d170de7ad12c6` |
| PaymentLanes | `0x5578929702b0158682286982e3f82d04a08f3b92` |
| HouseTokenFactory | `0x2067238186ee13d9c543742e1bb6be9fe4a1b20b` |
| Access0x1Subscriptions | `0xd3ac71914d01a8229d00c2cf9abc7f93237a253d` |
| Access0x1Bookings | `0xbcb59e981662d26769ff1fe5d75f66e38c68c99b` |
| Access0x1Invoices | `0x3ea759f15e7edefcbfa6b55c1d3bf8a40e596909` |
| Access0x1GiftCards | `0x2ba5411803bc7734652afa292bc97f39ae409f76` |

- **Deploy tx:** `0x099628a160499382d6d62a8bf70808313abf31b9a19926ae625d71c054a44611`
- **A real merchant is registered + live** (NFTeria, merchant #1), tx `0x3e61932ae31dc04c188802d5a3acf203e83df5ae895ffe0fa0b4544bcccfa620` — the live checkout at `access0x1.nfteria.click` has taken a real on-chain USDC payment.
- **Chainlink feeds wired in the broadcast:** native/USD `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`, USDC/USD `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165`.

**Still one-command ready (not broadcast):** zkSync Sepolia (300) — `make deploy-zksync-sepolia`, no tx hash yet.
`ChainRegistry` and `Access0x1Receiver` are config/audit sidecars (built; deploy is one call) alongside the core surface on the source-verified chains (Arc + Base Sepolia).

---

## 2. Tested

- **920 contract tests, 0 failed** (`make test`). Reproduce: `forge test`. (The 3 `test/fork/**`
  Chainlink-feed tests are counted in the 920 and short-circuit to a green no-op when no fork RPC is
  set, so a fresh clone and CI both run 920/920 green; set `BASE_SEPOLIA_RPC_URL` to exercise them live.)
- **~784 web tests** (Vitest).
- **13 headline money-safety invariants** (45 total invariant properties): native conservation, token
  conservation, platform cut always to treasury, zero-custody residual, merchant isolation, effective
  fee ≤ `MAX_FEE_BPS`, the PaymentLanes conservation set, and a 4-property cross-asset firewall.
  Fuzzed with **`fail_on_revert = true`** (a swallowed error counts as a failure) — 4,096 calls each
  per target locally (default `runs=64 × depth=64`), 32,768 in CI, which runs under `FOUNDRY_PROFILE=ci`
  (`runs=256 × depth=128` from `foundry.toml`; set in `.github/workflows/*.yml`).
- **Coverage (run `forge coverage --ir-minimum`):** 100% functions on the router; ~98–99% lines, ~97%
  branches (see `audit/FINDINGS.md`). The number in the README badge is whatever `forge coverage`
  actually prints — never inflated.
- **Static analysis:** Slither — 31 results across 12 detectors, all triaged, **0 exploitable**.
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
- **Two findings, self-caught and fixed before submission:** (M-1) a deploy-time guard so a USDC feed
  can't clobber the native price-feed slot; (M-2) snapshot of `periodSecs`/`priceUsd8` before the
  external call in `renew`, plus `nonReentrant` on `setPlan`.
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
- **World ID** — one-tap proof-of-personhood gate; nullifier dedup with replay protection; a Casino-Verified
  vertical that makes the gate mandatory for gaming merchants. (World ID proves a unique human only —
  not age, jurisdiction, or a gambling licence; we state that in-product.)
- **Circle x402 / Gateway** — gas-free USDC settlement via EIP-3009. **This is x402/Gateway, NOT CCTP** —
  there is zero burn-and-mint code in this repo.
- **OIDC/JWT identity layer**, **MetaMask Snap** (payment insight in the signing dialog), **`@access0x1/react`
  SDK** (drop-in `<PayButton>`, 15/15 tests, deployed at `sdk.nfteria.click`), and the `create-access0x1` scaffolder.

**Seam (code present, NOT exercised in the live demo path / booth-SDK-gated):**
- **Walrus** (decentralized storage), **Unlink** (private payout), **Blink** (one-tap funding),
  **Uniswap payout-swap** (receive-in-any-token rail), **paymaster** (gas sponsorship). We label these
  as seams everywhere — never as "live."

**Not built — we do NOT claim these:**
- Hedera, LI.FI, Canton, Ledger, 1inch, Google Cloud / BigQuery, Privy, CCTP, ERC-5570 / ERC-5192 / ERC-1155,
  and cbBTC is **not** in the live `SUPPORTED_PAY_TOKENS` list.

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
make test                       # 920 contract tests
forge coverage --ir-minimum     # the real coverage number
make anvil && make deploy-local && make drive-local   # real local payment, no keys
```
Then open the verified router on Blockscout (link above) and the live checkout at `access0x1.nfteria.click`.

---

*This audit is intentionally public. We would rather you catch a gap here than be surprised on stage.
Everything claimed is reproducible from this repository; everything unfinished is labeled as such.*
