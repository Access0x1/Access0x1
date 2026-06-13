# Access0x1 — Static-analysis findings tracker (`router-core`)

The money spine (`Access0x1Router.sol` + `OracleLib.sol`) is analysed on every
build. This file is the honest disposition of every finding the tools raise — the
real-audit convention is to *resolve or justify*, never to silently suppress.

| Layer | Result |
| --- | --- |
| `forge test` | 64 tests green (52 unit · 6 invariant · 6 oracle) |
| `forge coverage` (router) | **100%** lines · 100% statements · 100% branches · 100% functions |
| Invariants | 5 money invariants hold over 64×64 = 4096 calls, 0 reverts under `fail_on_revert` |
| `slither .` (v0.11.5) | **0 results** after config — every src finding suppressed with a justified inline directive (below) |
| `aderyn` (v0.6.8) | 1 High + 3 Low, **all triaged as false-positive / by-design / style** (below) |

Tooling config: [`slither.config.json`](../slither.config.json) filters
`lib/ node_modules/ test/ script/` so analysis focuses on `src/`. Aderyn's
generated `report.md` is gitignored; this file is the curated record.

---

## Slither — `0 results` (suppressions justified inline)

Each was confirmed by-design and carries a `// slither-disable-next-line` with the
reasoning at the call site:

| Detector | Where | Why it is safe |
| --- | --- | --- |
| `arbitrary-send-eth`, `low-level-calls` | `_pushNativeOrQueue`, refund in `payNative`, `claimRescue` | A payments router must push native value to merchant/treasury/fee/buyer addresses; `.transfer` caps gas at 2300 and breaks smart-account payees, so a low-level `call` is required. Recipients are caller-configured (zero-checked at register/update/constructor/setTreasury) or `msg.sender` — never arbitrary. |
| `reentrancy-eth`, `reentrancy-benign` | `payNative`, `_pushNativeOrQueue` | The only post-call state write is the failure-path `rescue` credit. Every entry point (`payNative`/`payToken`/`claimRescue`) is `nonReentrant`, so the shared guard makes cross-function reentrancy on `rescue` impossible. CEI ordering is preserved (effects + event before the pushes). |
| `unused-return` | `quote` | Only the feed `answer` is needed; the staleness guard already reverted a stale/invalid round, so the other tuple fields are intentionally dropped. |
| `timestamp` | `OracleLib.staleCheckLatestRoundData` | Comparing `block.timestamp - updatedAt` against a 1-hour window **is** the staleness guard (canonical Chainlink pattern); minute-scale validator drift cannot defeat it. |

## Aderyn — all findings triaged

| ID | Title | Disposition |
| --- | --- | --- |
| **H-1** | ETH transferred without address checks (`claimRescue`) | **False positive.** The recipient is `msg.sender`, which is inherently non-zero and is exactly the party owed the rescued funds. No address check is meaningful. |
| **L-1** | Centralization risk (7×: owner setters + pause) | **By design, documented trust assumption.** `Ownable2Step` admin controls fees, treasury, the token/feed allowlist, and the pause circuit-breaker — a burner key at the event, a multisig in production. The owner has **no** path to merchant funds: settlement is atomic and zero-custody, and the only owner-reachable balance is the platform fee leg sent to the treasury it configures. |
| **L-2** | Large numeric literal (`FEE_DENOMINATOR = 10_000`) | **Intentional.** `10_000` reads as a basis-point denominator far more clearly than `1e4`; underscore-separated and named. |
| **L-3** | Literal instead of constant (`10 ** (feedDecimals + tokenDecimals)`) | **Idiomatic.** The remaining literal is the base-`10` of decimal scaling, not a magic number. The one real instance it first flagged — the USD scale `10 ** 8` — was resolved by extracting `USD_DECIMALS`. |

## Manual review + adversarial testing

Beyond the static tools, the money path is covered by the Fable red-team
(`test/attack/**`, exploit tests only) and the 5 invariants. Key guarantees the
suite proves: `net + platformFee + merchantFee == gross` exactly; the platform
cut always reaches the treasury (a merchant can never redirect it); the router
holds no token and only the native owed back through `rescue`; a payment to one
merchant never mutates another; and no payment is ever charged more than
`MAX_FEE_BPS`, even after a platform-fee change under an existing surcharge.
