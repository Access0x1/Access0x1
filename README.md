# Access0x1

**An open-source, on-chain layer for payments + auth + agents that any developer integrates with one link and no contract code.**

[![CI](https://github.com/Access0x1/Access0x1/actions/workflows/test.yml/badge.svg)](https://github.com/Access0x1/Access0x1/actions/workflows/test.yml)
[![Router coverage 100%](https://img.shields.io/badge/router%20coverage-100%25-brightgreen)](audit/FINDINGS.md)
[![Slither 0 findings](https://img.shields.io/badge/slither-0%20findings-brightgreen)](audit/FINDINGS.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A business registers once and accepts USD-priced crypto with a single link. One shared, multi-tenant
[`Access0x1Router`](src/Access0x1Router.sol) serves every merchant — **no per-merchant contract, no
custody.** Each payment prices USD → token through a Chainlink feed read *inside the settlement
transaction*, splits an exact fee, and pushes the net to the merchant in the same tx. The contract
never holds merchant funds.

> ETHGlobal NY 2026 build. The money spine (`router-core`) is complete, green, and on a public branch
> from commit #1.

---

## Why it's different

- **Zero custody.** Settlement is atomic: pull → split → push, all in one tx. The router's steady-state
  balance is zero; the only native it can hold is value owed back through `claimRescue` when a payee
  contract rejects a push (the receipt still stands — funds are never stuck).
- **USD pricing, on-chain.** `quote()` reads a Chainlink `<token>/USD` feed through a staleness guard
  *in the pay tx* — the price that drives settlement, not a frontend preview. Decimals are read live
  (feed, token), so the Arc trap (native USDC = 18 dp, ERC-20 USDC = 6 dp, feed = 8 dp) is safe.
- **One router, many merchants.** A permissionless `registerMerchant` → `merchantId`; the caller owns
  their config and nobody else's. A payment to merchant A can never mutate merchant B.
- **Exact, capped fees.** A single total fee splits two ways — the platform cut always lands at the
  treasury (a merchant can never redirect it), the merchant surcharge at the merchant's recipient —
  and `net + platformFee + merchantFee == gross` holds exactly. No payment is ever charged more than
  `MAX_FEE_BPS` (10%), even after a fee change under an existing surcharge.

## Status — `router-core`

| | |
| --- | --- |
| Tests | **65 green** — 52 unit · 6 invariant · 6 oracle · 1 deploy |
| Router coverage | **100%** lines · 100% statements · 100% branches · 100% functions |
| Invariants | **5 money invariants** hold over 4096 fuzz calls, 0 reverts |
| Static analysis | **slither: 0 findings** · aderyn triaged → [`audit/FINDINGS.md`](audit/FINDINGS.md) |

The five invariants: `fee + net == gross` · platform cut always to treasury · zero-custody residual ·
merchant isolation · fee ≤ `MAX_FEE_BPS`.

## Quickstart

```sh
git clone https://github.com/Access0x1/Access0x1.git
cd Access0x1
forge install          # OpenZeppelin + forge-std (git submodules)
npm ci                 # @chainlink/contracts (npm, pinned 1.5.0)
forge build
forge test             # 65 green
forge coverage         # 100% on the router
```

Deploy to a local Anvil (deploys mock feeds + a mock USDC, then the router):

```sh
anvil &
forge script script/DeployAccess0x1Router.s.sol --rpc-url http://localhost:8545 \
  --account <keystore> --broadcast
```

> Live deploys read every address from the environment (`PLATFORM_TREASURY`, `NATIVE_USD_FEED`,
> `USDC_ADDRESS`, `USDC_USD_FEED`) — never a hardcoded address. Signing is keystore-only.

## The contract surface

| Function | What it does |
| --- | --- |
| `registerMerchant(payout, feeRecipient, feeBps, nameHash)` | Permissionless onboarding → `merchantId`. Caller becomes the merchant owner. |
| `updateMerchant(id, …)` | Merchant-owner-only config update. `owner` + `nameHash` are immutable. |
| `quote(id, token, usdAmount8)` | USD (8 dp) → token amount via the Chainlink feed + staleness guard. |
| `payNative(id, usdAmount8, orderId)` | Pay in the chain's native coin. Refunds excess; queues failed pushes to `rescue`. |
| `payToken(id, token, usdAmount8, orderId)` | Pay in an allowlisted ERC-20. Rejects fee-on-transfer via the balance delta. |
| `claimRescue()` | Pull-pattern withdrawal of value queued when a push failed. Open even while paused. |
| `setPlatformFee` · `setTreasury` · `setTokenAllowed` · `setPriceFeed` · `pause` · `unpause` | `Ownable2Step` admin. |

Architecture: [`OracleLib`](src/libraries/OracleLib.sol) (staleness guard, internal/inlined) →
[`Access0x1Router`](src/Access0x1Router.sol) (`Ownable2Step` + `Pausable` + `ReentrancyGuard`,
`SafeERC20`). Full spec + the five invariants under a handler in
[`test/invariant`](test/invariant/Access0x1Router.invariant.t.sol).

## Security posture

`SafeERC20` · `nonReentrant` on every pay path · CEI ordering · custom errors · events on every state
change · Chainlink staleness guard · fee-on-transfer rejection · no unbounded loops · `Ownable2Step`
admin. Money paths roll back rather than swallow; refunds and rescues are never blocked. Every static
finding is resolved or justified in [`audit/FINDINGS.md`](audit/FINDINGS.md).

Secrets never enter the repo (env + `cast wallet` keystore only); the deployer is a burner key.

## Stack

Foundry · Solidity 0.8.28 (EVM cancun, via-IR) · OpenZeppelin 5.6.1 · Chainlink contracts 1.5.0.
Targets Arc, Base, and zkSync testnets.

## License

[MIT](LICENSE).
