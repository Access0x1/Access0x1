# Gas

Hot-path gas costs for the Access0x1 contracts. Numbers are the **runtime** per-call
figures from `forge test --gas-report` (the `forge snapshot` baseline lives in
[`.gas-snapshot`](../.gas-snapshot) at the repo root and is regenerated alongside this file).

> Reproduce: `forge snapshot` (per-test totals) · `forge test --gas-report` (per-function
> min/avg/median/max). Solidity 0.8.28, `via_ir`, optimizer 200 runs, EVM cancun.

## The money spine — `Access0x1Router`

The settlement paths are the only ones a buyer pays for, so they are the costs that matter.
Both read a Chainlink feed **inside** the tx (the staleness-guarded `quote`), split the fee,
and push the legs out — all in one call.

| Function | Min | Median | Max | What it is |
| --- | ---: | ---: | ---: | --- |
| `payNative` | 29,626 | 95,526 | 173,101 | Pay in the native coin: in-tx quote → split → push net + fees, refund excess. |
| `payToken` | 29,718 | 105,177 | 213,060 | Pay in an allowlisted ERC-20: pull-and-verify → split → `SafeERC20` pushes. |
| `quote` | 483 | 18,149 | 23,520 | USD(8dp) → token via the feed + staleness guard. Folded into both pay paths. |
| `registerMerchant` | 22,586 | 122,209 | 122,221 | One-time merchant onboarding (writes the merchant record). |
| `updateMerchant` | 25,049 | 39,880 | 39,904 | Mutate a merchant's payout / fee / active config. |
| `setPlatformFee` | 23,747 | 30,129 | 30,141 | Admin fee change (one `uint16` write + event). |
| `claimRescue` | — | 28,587 | — | Pull a queued native push that failed during settlement. |

The `payToken` max (213k) is the **PaymentLanes-enabled** branch (approve → `credit` →
mint a lane receipt); with no lanes configured (the default) token settlement is a plain
`SafeERC20.safeTransfer` and lands near the median. Deployment: ~1.74M gas.

## Receipts — `PaymentLanes` (ERC-6909)

| Function | Min | Median | Max | What it is |
| --- | ---: | ---: | ---: | --- |
| `credit` | 29,548 | 71,986 | 111,155 | Router mints a lane receipt and pulls the backing asset in (CEI). |
| `claim` | 26,628 | 57,235 | 67,911 | Merchant burns its own lane and pulls the underlying. |
| `claimLane` | 27,216 | 32,137 | 62,503 | Burn an explicit (e.g. transferred) lane id. |
| `transfer` | 22,187 | 52,429 | 52,489 | Move a lane receipt (pure bookkeeping, no external call). |
| `laneId` | 573 | 573 | 573 | `pure` — recompute a lane id off-chain for free. |

Deployment: ~768k gas.

## Agent sessions — `SessionGrant` (ERC-7702 / ERC-6492)

| Function | Min | Median | Max | What it is |
| --- | ---: | ---: | ---: | --- |
| `openSession` | 21,877 | 118,945 | 118,945 | Owner-as-caller open (ERC-7702 entrypoint). |
| `openSessionFor` | 22,951 | 83,632 | 302,878 | Relayed EIP-712 grant; max is the ERC-6492 counterfactual-deploy path. |
| `spend` | 22,075 | 35,845 | 52,945 | The agent hot path — a single budget write. |
| `revoke` | 24,091 | 39,178 | 49,929 | Owner kill switch. |
| `remaining` / `nonces` | 2,570 | — | 9,015 | Liveness / replay-nonce reads. |

The `openSessionFor` max reflects the one external call in the whole contract — the ERC-6492
factory `prepare`/deploy for a wallet that is not yet on-chain. Deployment: ~1.05M gas.

## Audit consumer — `Access0x1Receiver` (CRE)

| Function | Min | Median | Max | What it is |
| --- | ---: | ---: | ---: | --- |
| `onReport` | 24,238 | 55,601 | 56,273 | Forwarder-gated audit write (off the money path — never blocks settlement). |
| `supportsInterface` | 238 | 270 | 270 | ERC-165 probe the Forwarder calls before delivery. |

Deployment: ~494k gas.

## Reference — `ChainRegistry`

A storage-only sidecar (no value path). `getChain` ~5,743 · `isLive` ~2,337 · reads only.

## Where the gas goes (and why it stays low)

- **No per-merchant deploy.** One shared router serves every merchant; onboarding is a single
  `registerMerchant` write, not a contract deployment.
- **Zero custody, atomic settlement.** Pay paths pull, split, and push in one tx — no escrow
  SLOADs, no second-tx withdrawal for the common case.
- **`unchecked` where proven safe.** Budget/nonce/balance arithmetic that is bounded by a
  prior check skips the redundant overflow guard (see `SessionGrant.spend`, `PaymentLanes._transfer`).
- **Custom errors, not require-strings** — every revert path is a 4-byte selector.
- **Packed structs.** `Merchant` packs `feeRecipient`+`feeBps`+`active` into one slot; the
  `Session` struct shares `delegate`+`expiry`.
- **`OracleLib` is `internal`** — it inlines into the router, so there is no library `delegatecall`
  and no link step at the cost of one staleness check per `quote`.
