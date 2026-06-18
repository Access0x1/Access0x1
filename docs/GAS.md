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
| `payNative` | 7,975 | 87,867 | 173,026 | Pay in the native coin: in-tx quote → split → push net + fees, refund excess. |
| `payToken` | 7,717 | 105,127 | 217,755 | Pay in an allowlisted ERC-20: pull-and-verify → split → `SafeERC20` pushes. |
| `quote` | 492 | 25,741 | 34,601 | USD(8dp) → token via the feed + staleness guard (+ optional L2 sequencer-uptime check). Folded into both pay paths. |
| `registerMerchant` | 2,611 | 122,176 | 122,200 | One-time merchant onboarding (writes the merchant record). |
| `updateMerchant` | 25,049 | 39,880 | 39,904 | Mutate a merchant's payout / fee / active config. |
| `setPlatformFee` | 23,747 | 30,129 | 30,141 | Admin fee change (one `uint16` write + event). |
| `claimRescue` | — | 28,587 | — | Pull a queued native push that failed during settlement. |

The `payToken` max (~218k) is the **PaymentLanes-enabled** branch (approve → `credit` →
mint a lane receipt); with no lanes configured (the default) token settlement is a plain
`SafeERC20.safeTransfer` and lands near the median. Deployment: ~1.74M gas.

> **Reading the `Min` column:** these are the raw `forge test --gas-report` figures over the
> whole suite, so `Min` is the cheapest *measured* call — often a guarded early-reject (e.g. a
> paused contract or a zero-amount revert costs ~8k), not the cheapest settlement. The **Median**
> is the representative successful cost. `quote`'s median rose ~7k vs. the prior snapshot: the
> audit M-1 L2 sequencer-uptime guard adds one `sequencerUptimeFeed` SLOAD per `quote` (and the
> branch when a feed is configured) — paid only where an L2 sequencer feed is set.

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

## Commerce primitives — the quintet (compose the spine)

`Access0x1Subscriptions`, `Access0x1Bookings`, `Access0x1Invoices`, `Access0x1GiftCards`,
and `Access0x1Nft` never re-derive the money path — each one settles **through**
`Access0x1Router.payToken` / `payNative` (the ~90–105k spine above), then layers its own
lifecycle bookkeeping on top. So the figures below are *spine + primitive*, and the heavier
ones are dominated by first-touch cold `SSTORE`s (a new subscription/booking/listing record)
that warm on repeat.

| Function | Median | Max | What it is |
| --- | ---: | ---: | --- |
| `Subscriptions.subscribe` | 297,893 | 409,771 | Open a plan + first charge through the router (new record + first settle). |
| `Subscriptions.renew` | 186,558 | 243,518 | The recurring hot path: debit the `SessionGrant` budget + settle one period. |
| `Bookings.reserve` | 420,885 | 448,223 | Escrow a USD-priced deposit (in-tx quote + ERC-20 escrow + booking record). |
| `Bookings.cancel` | 174,834 | 219,642 | Re-quote the policy fee, refund the remainder (refund never blocked). |
| `Invoices` settle | 170,814 | 206,392 | Pay a one-shot request through the router (`OPEN → PAID`, absorbing). |
| `GiftCards.redeem` | 121,137 | 121,197 | Draw down a prepaid USD balance (never-negative). |
| `Nft.list` | 249,828 | 252,616 | Escrow an ERC-721 + write the listing (a `quote` price-probe fails fast). |
| `Nft.buy` | 248,335 | 248,335 | Pull gross → settle through the router → atomic `safeTransferFrom` of the NFT. |

The router's proven invariants (`net + fee == gross`, zero-custody, tenant isolation, fee cap)
carry to every row — none re-implements the fee math. Deployments are one-time per chain.

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
