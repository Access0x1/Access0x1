# For protocols: what your stack gave us, and what we found in it

This page is written for an engineer **at** one of the protocols this repo integrates. It is not a
list of what Access0x1 built. It is the return leg: for each protocol, what we call, what we learned
by calling it that the published docs do not say, and what we would change about the interface.

Every entry cites the file that proves it. A claim with no path behind it does not appear here.

**How to use it.** Read your own section. Where the finding is right, take it — the repo is MIT and
the text is yours to lift into your docs. Where the finding is wrong, that is a defect in a public
reference implementation, and the fastest fix is an issue titled `integration(<you>): …` or a PR
against `dev`; the lane is in [`CONTRIBUTING.md`](../CONTRIBUTING.md#for-a-protocol-or-company-adapting-this-repo-to-you).

**Label key** — three different words, used strictly:

| Label | Meaning |
| --- | --- |
| **live** | Broadcast-recorded and re-verifiable on a public testnet with the command given in the entry. |
| **built, env-gated** | On `main`, tested offline, dormant until an operator sets the named variable. Never provisioned by us. |
| **designed** | Real client code against a published spec, mapped to no chain and proven against no live endpoint. |

**Scope.** Testnets only. This repo has no mainnet deployment and makes no mainnet claim. Every
address below comes from a committed `broadcast/` record.

---

## Chainlink — Data Feeds · CCIP · Automation · CRE

**What we use.** `@chainlink/contracts@1.5.0`. `AggregatorV3Interface` inside
[`src/libraries/OracleLib.sol`](../src/libraries/OracleLib.sol),
[`src/PriceOracleAdapter.sol`](../src/PriceOracleAdapter.sol) and `Access0x1Router.quote()` — the feed
read happens **inside the settlement transaction**, not in a frontend preview.
`AutomationCompatibleInterface` in [`src/AutomationGateway.sol`](../src/AutomationGateway.sol). CCIP
`IRouterClient` + `IAny2EVMMessageReceiver` re-declared locally in
[`src/interfaces/ICcipRouterClient.sol`](../src/interfaces/ICcipRouterClient.sol). The CRE TypeScript
SDK in [`cre/workflow.ts`](../cre/workflow.ts): an EVM-log trigger → HTTP notify → `writeReport` through
the KeystoneForwarder.

**What we learned that your docs do not say.**

- **`startedAt == 0` on a sequencer uptime feed is a third state, and the canonical snippet skips it.**
  The documented reading is `answer == 0` ⇒ up, `answer == 1` ⇒ down. A feed that has posted no round
  yet returns `startedAt == 0`, which the canonical guard treats as "up and started at the epoch" —
  it is untrusted, not up. Our guard rejects both cases in one condition:
  [`src/libraries/OracleLib.sol`](../src/libraries/OracleLib.sol) (`checkSequencerUp`).
- **The CCIP Router accepts overpayment without refunding it.** That fact belongs next to `ccipSend`,
  not three pages away — a sender that skips `getFee` silently burns the excess. Ours quotes with
  `getFee` and refunds the difference itself. Recorded verbatim at
  [`src/interfaces/ICcipRouterClient.sol`](../src/interfaces/ICcipRouterClient.sol).
- **A CCIP receiver that reverts on an ordinary business outcome converts every one of those into a
  manual re-execution ticket.** Our destination credits a claimable balance instead of reverting:
  [`src/Access0x1CcipReceiver.sol`](../src/Access0x1CcipReceiver.sol).
- **The 3h canonical staleness window is wrong for a 24h-heartbeat feed, in both directions.** We run
  a 1h default plus a per-feed `maxStaleness` overload, because a USDC/USD feed on a 24h heartbeat is
  legitimately fresh well past either number.
- **The CRE WASM runtime is Javy/QuickJS, not Node — and that constraint is load-bearing.** No
  `Date.now`, no `node:crypto`, no `fetch`; every amount decodes as `bigint`; a webhook body needs a
  fixed key order so every DON node produces byte-identical bytes. Three lines of documentation there
  would replace a debugging session against failed DON consensus. Written up at the top of
  [`cre/workflow.ts`](../cre/workflow.ts).
- **`internal` beats a deployed library for the zkEVM path.** `OracleLib` is `internal` on purpose so
  `zksolc` never faces a library link step.
- **Hedera does document Chainlink feeds** via the Price Feeds Adapter. An earlier comment in this repo
  asserted the opposite and was corrected in place — the correction and its residual live at
  [`web/lib/chains.ts`](../web/lib/chains.ts) (`hederaTestnet`).

**What we would change.** Put the overpayment rule in the `ccipSend` signature docs. Add the
`startedAt == 0` case to the published sequencer-guard snippet. State the runtime name (Javy/QuickJS)
on the first page of the CRE SDK docs rather than leaving it to be inferred from a consensus failure.

**Labels.** Data Feeds: **live** on the mirrored chains that carry feeds. CCIP sender/receiver:
**built, env-gated** — no lane wiring broadcast. `AutomationGateway`: **built** — upkeep registration
is operator work. CRE: **built, simulate-only**; deploy access is approval-gated and we do not claim a
self-served live deploy.

---

## Circle — USDC · Arc · Gateway · x402

**What we use.** `@circle-fin/x402-batching` `BatchFacilitatorClient` (verify → settle), EIP-3009
authorizations, the EIP-712 `GatewayWalletBatched` v1 domain against the Gateway Wallet, the Gateway
balances API, and Arc testnet 5042002 with USDC as the native gas token. Files:
[`web/lib/x402.ts`](../web/lib/x402.ts), [`web/lib/x402/config.ts`](../web/lib/x402/config.ts),
[`web/lib/arc-constants.ts`](../web/lib/arc-constants.ts), [`web/lib/chains.ts`](../web/lib/chains.ts),
[`docs/ARC-DEPLOY.md`](ARC-DEPLOY.md).

**What we learned that your docs do not say.**

- **The Arc trap: native USDC on Arc is 18-decimal while bridged USDC elsewhere is the canonical
  6-decimal ERC-20.** A hardcoded `6` divides an Arc amount by 10^6 — a 10^12 display error, in the
  one place a payer looks. This is the single most reusable finding in this document and it is
  invisible to anyone reading the USDC contract list alone. We resolve decimals per chain for display
  and read `decimals()` on-chain for money: [`web/lib/chains.ts`](../web/lib/chains.ts)
  (`USDC_DECIMALS_BY_CHAIN`).
- **The Arc testnet mempool rejects transactions priced below 20 gwei.** A deploy needs
  `--gas-price 20000000000` or it never lands. Recorded with the full runbook at
  [`docs/ARC-DEPLOY.md`](ARC-DEPLOY.md).
- **Arc's Blockscout verifier URL may need a trailing `?`** to suppress the Etherscan `&apikey=`
  suffix Foundry appends. Same file.
- **The Gateway chain key is `arcTestnet` in one SDK and `arc-testnet` in another, for the same chain
  id.** One of the two spellings should win. Noted at
  [`web/lib/arc-constants.ts`](../web/lib/arc-constants.ts).
- **Arc publishes no Chainlink USDC/USD feed**, so a payments deploy stands up a `$1`
  `MockV3Aggregator` first and states the mock at every quote —
  [`script/DeployArcUsdFeed.s.sol`](../script/DeployArcUsdFeed.s.sol). `DeployAll` skips the wiring with
  a warning rather than failing the run.
- **A Next.js-specific one worth a callout in the x402 quickstart:** `next build` loads every route
  module to collect page data, so building payment requirements eagerly at module load forces a
  runtime secret into the build environment. We memoize lazily on first request instead —
  [`web/lib/x402.ts`](../web/lib/x402.ts) (`withGateway`).

**What we would change.** Put the 18-vs-6 decimal difference at the top of the Arc page, not in a
chain-spec table. Publish the minimum gas price. Pick one Gateway chain-key casing.

**Labels.** Arc chain deploy: **live** — the CREATE3 mirror on 5042002, source-verified. x402 seller
spine: **built, env-gated** — `SELLER_ADDRESS` unset yields a clean `not_configured`. App Kit Swap
rail: **built, env-gated** behind an injected SDK seam, method names flagged confirm-before-use at
[`web/lib/payout-swap/rails/circleAppKit.ts`](../web/lib/payout-swap/rails/circleAppKit.ts).

---

## Uniswap — v4 hooks · Trading API

**What we use.** `@uniswap/v4-core@1.0.2` (`IHooks`, `PoolKey`, `PoolId`, `BalanceDelta`, `SwapParams`)
remapped from npm rather than a submodule; v4-periphery `PoolSwapTest` / `PoolModifyLiquidityTest` on
Ethereum Sepolia. On the REST side, `/quote` → `/check_approval` → `/order` | `/swap` | `/swap_7702`
at [`web/lib/payout-swap/rails/uniswapTradingApi.ts`](../web/lib/payout-swap/rails/uniswapTradingApi.ts).

**What we learned that your docs do not say.**

- **`/check_approval` covers only the ERC20→Permit2 leg.** The Permit2→Router grant rides the signed
  `permitData` a REST-only integrator strips, and without it the Universal Router `execute` reverts on
  a wallet that is funded and ERC20-approved. `generatePermitAsTransaction: true` is the fix, and
  nothing in the docs connects that field to this revert. The finding is carried at the call site so
  the next maintainer does not remove it:
  [`web/lib/payout-swap/rails/uniswapTradingApi.ts`](../web/lib/payout-swap/rails/uniswapTradingApi.ts).
- **Testnet coverage is per-chain and undocumented.** Ethereum Sepolia (11155111) served a priced
  one-hop CLASSIC quote with a gas estimate; Base Sepolia answered `ResourceNotFound: "No quotes
  available"` for the same canonical USDC→WETH pair, same request shape, same minute.
- **Response shape: there is no top-level `amountOut`.** CLASSIC nests at `quote.output.amount`,
  UniswapX at `quote.orderInfo.outputs[]`. Chain ids travel as **strings** (`tokenInChainId`), and the
  amount field is `amount`.
- **A UniswapX slippage floor must read `outputs[0].endAmount`, never `startAmount`** — the decay start
  is not the guarantee.
- **The Cloudflare front returns error 1010 to some non-browser client signatures.** A Python `urllib`
  caller is blocked; `curl` and an explicit product User-Agent pass. `x-universal-router-version: 2.0`
  rides every call including `/quote`. Both are encoded in the keyed fetch at
  [`web/lib/payout-swap/deps-from-env.ts`](../web/lib/payout-swap/deps-from-env.ts).
- **On the v4 side: the flag mine is ~16,384 expected keccaks for one AFTER_SWAP address**, and a
  mirror of the internal `Hooks.ALL_HOOK_MASK` can drift silently against v4-core. Our deploy asserts
  `uint160(hook) & ALL_HOOK_MASK == hook.REQUIRED_HOOK_FLAGS()` **after** broadcast so a drift fails the
  run loudly instead of producing a hook the PoolManager rejects:
  [`script/DeploySwapReceiptHook.s.sol`](../script/DeploySwapReceiptHook.s.sol).

**What we would change.** Publish which testnets the Trading API actually serves, per chain. Name the
`generatePermitAsTransaction` field on the `/check_approval` page with the revert it prevents. State
the `endAmount` rule in the UniswapX quote reference. Expose `ALL_HOOK_MASK` publicly in v4-core so an
integrator stops mirroring an internal constant.

**Standard vs bespoke, stated plainly.** The hook implements the published `IHooks` interface exactly,
all ten callbacks, address flags mined per v4's own rule. The receipt it emits is **ours**:
`SwapReceipt(poolId, sender, merchantId, orderRef, delta)` is an Access0x1 event that no Uniswap
indexer knows about, and we do not present it as a Uniswap shape —
[`src/uniswap/Access0x1SwapReceiptHook.sol`](../src/uniswap/Access0x1SwapReceiptHook.sol).

**Labels.** v4 hook: **live** on Ethereum Sepolia at
[`0x4d6cF3e12C331393880df02b53017A478A6ec040`](https://sepolia.etherscan.io/address/0x4d6cf3e12c331393880df02b53017a478a6ec040),
broadcast-recorded plus a live-fire swap through it
([`script/LiveFireSwapReceipt.s.sol`](../script/LiveFireSwapReceipt.s.sol)). Re-verify:

```sh
cast call 0x4d6cF3e12C331393880df02b53017A478A6ec040 "POOL_MANAGER()(address)" --rpc-url "$SEPOLIA_RPC_URL"
```

Trading API rail: **live-proven once** on Ethereum Sepolia, otherwise **built, env-gated** (dormant
absent `UNISWAP_TRADING_API_URL`). The `/swap_7702` REST path: **designed**. The running list of asks
and their answers, including one we retired because we had been wrong, is [`FEEDBACK.md`](../FEEDBACK.md).

---

## ENS — resolution · ENSIP-11/19 · ENSIP-25/26 · a payment resolver

**What we use.** viem ENS plus the Universal Resolver's ENSIP-19 `reverse(bytes,uint256)`; ENSIP-11
coinTypes; an on-chain resolver implementing EIP-137 `addr`, ENSIP-9/11 `addr(bytes32,uint256)`,
ENSIP-5 `text`, ENSIP-10 `resolve` and ERC-165; ENSIP-25/26 agent records over ERC-7930; the
ETHRegistrarController for in-app name registration; Namestone for off-chain issuance.

**What we learned that your docs do not say.**

- **ENSIP-11's `0x80000000 | chainId` silently wraps above 2^31.** The bitwise `|` runs `ToInt32`
  first, so a chain id ≥ 2^31 collides with `(chainId mod 2^31)`'s coinType — which routes a real USDC
  payment to a *different chain's* address. Our encoder refuses rather than mis-encoding, and `>>> 0`
  is required because a plain `|` reads negative in JS. Both facts at
  [`web/lib/ens.ts`](../web/lib/ens.ts) (`toCoinType`).
- **Omitting `coinType` on an L2 returns the mainnet address**, which may not exist on that chain. A
  null resolution throws in our money path rather than falling back to it.
- **The ENSIP-25 ERC-7930 registry segment needs a byte layout in the spec text**, not only an example:
  `version‖chainType‖chainRefLen‖chainRef‖addrLen‖address`. We wrote it out and assert it byte-for-byte
  against the spec's own mainnet ERC-8004 example —
  [`web/lib/agent/ensIdentity.ts`](../web/lib/agent/ensIdentity.ts).
- **`includes('.')` beats `endsWith('.eth')`** as the "is this a name" test, so DNS imports, subnames
  and emoji domains resolve. Same file as the coinType finding.
- **The Namestone key rides `Authorization` with no `Bearer` prefix** —
  [`web/lib/ens-subnames.ts`](../web/lib/ens-subnames.ts). Namestone also carries a published sunset
  date, which is why we demoted it to a fallback and built the successor in-repo.

**What we would change.** Add the 31-bit range constraint and the JS sign-bit note to ENSIP-11. Add the
byte-layout table to ENSIP-25. Say in the Universal Resolver docs that a missing `coinType` falls back
to mainnet rather than failing.

**Labels.** Resolution and the ENSIP-19 badge: **live** (mainnet reads, off the money path). The
on-chain [`Access0x1PaymentResolver`](../src/ens/Access0x1PaymentResolver.sol): **live** on Ethereum
Sepolia — UUPS proxy
[`0x9c9ADe797451309925Ef400e99b289Ee1EA1d237`](https://sepolia.etherscan.io/address/0x9c9ade797451309925ef400e99b289ee1ea1d237),
broadcast-recorded at `broadcast/DeployPaymentResolver.s.sol/11155111/run-latest.json`, bind gate armed
with the official ENS registry. Re-verify:

```sh
cast call 0x9c9ADe797451309925Ef400e99b289Ee1EA1d237 "chainCoinType()(uint256)" --rpc-url "$SEPOLIA_RPC_URL"
```

Namestone write: **built, env-gated**. ENSv2 registry seam: **built, env-gated** against alpha
addresses — [`docs/ENSV2-PAYMENT-RESOLVER.md`](ENSV2-PAYMENT-RESOLVER.md).

**One schema, three issuers.** The identical `click.access0x1.*` text-record schema is served by static
Namestone, the off-chain gateway, and the on-chain resolver, held in lockstep by shared constants. The
keys are ours but namespaced per ENS convention, so they collide with nothing.

---

## The Graph — subgraph · matchstick · `_meta`

**What we use.** Manifest `specVersion 1.0.0` / `apiVersion 0.0.9`, `graph-cli 0.98.1` with
`graph-ts 0.38.2`, AssemblyScript mappings, matchstick tests, and the standard `_meta` field.
Everything under [`subgraph/`](../subgraph), read by
[`web/lib/graph-analytics.ts`](../web/lib/graph-analytics.ts) and
[`web/lib/dashboard-receipts.ts`](../web/lib/dashboard-receipts.ts).

**What we learned that your docs do not say.**

- **Finding a `startBlock` for a CREATE3 deployment has no documented method.** A CREATE3 deploy leaves
  no top-level CREATE in any broadcast record, so the usual "read it off the deploy transaction" advice
  does not apply. We binary-searched `eth_getCode` — code absent at 43188205, present at 43188206 — and
  the manifest carries the *method*, not only the number, so the next reader can redo it:
  [`subgraph/subgraph.yaml`](../subgraph/subgraph.yaml).
- **Cross-decimal aggregation is a money bug the schema layer can prevent.** Summing a 6-decimal USDC
  amount and an 18-decimal native amount into one `BigInt` produces garbage. Token base-unit totals
  therefore live one row per `(merchant, token)` and only the 8-decimal USD total is cross-token:
  [`subgraph/schema.graphql`](../subgraph/schema.graphql). A worked example of this in the aggregation
  docs would stop a class of silent errors.
- **Mirroring an `owner` field off a generic update event is silently wrong** wherever ownership moves
  through a separate two-step event. Ours reads the dedicated event —
  [`subgraph/src/mapping.ts`](../subgraph/src/mapping.ts).
- **`_meta.block.number` and `hasIndexingErrors` deserve promotion in the quickstart.** Surfacing them
  lets a UI label data "as of block N" instead of trusting a lagging index —
  [`web/lib/graph-analytics.ts`](../web/lib/graph-analytics.ts).
- **The honest boundary of what an index buys, stated as a design fact:** a cross-entity top-N ranking
  is exactly the query a bounded per-contract `getLogs` window structurally cannot answer. That read is
  the one place in this repo with no chain fallback, and we say so rather than pretending parity.

**What we would change.** Add a "deterministic-factory deployments" note to the `startBlock` guidance.
Add a cross-decimal warning to the aggregation docs. Show `_meta` in the first quickstart query.

**Labels.** **Built, env-gated.** `codegen` and `build` validate offline; Studio deploy and
`NEXT_PUBLIC_ACCESS0X1_SUBGRAPH_URL` are unset in every deployment today, so both readers report
dormant. Everything is standard — your manifest, your schema directives (`@entity(immutable:)`,
`@derivedFrom`), your `_meta`.

---

## 0G — Galileo chain · 0G Compute

**What we use.** Galileo (16602) as a deploy target, and 0G Compute as an inference backend in two auth
modes behind one `runInference` seam: [`web/lib/ai/inference.ts`](../web/lib/ai/inference.ts),
[`web/lib/ai/agentInference.ts`](../web/lib/ai/agentInference.ts),
[`docs/0G-COMPUTE-INFERENCE.md`](0G-COMPUTE-INFERENCE.md).

**What we learned that your docs do not say.**

- **0G Compute has no static API key, and that changes what an integrator has to provision.** Broker
  mode mints single-use signed billing headers per request, so the prerequisite is a *funded wallet*,
  not a credential. Docs written in the shape of "get your API key" mislead here. We ship both shapes
  so an operator picks — [`docs/0G-COMPUTE-INFERENCE.md`](0G-COMPUTE-INFERENCE.md).
- **CreateX is absent on Galileo.** Every other chain in our set carries it, so a same-address CREATE3
  deploy needs a factory bootstrap first. CreateX ships as a pre-signed keyless transaction from a
  fixed one-time deployer EOA, so the bootstrap is "fund the deployer, broadcast the pre-signed tx":
  [`script/bootstrap-createx-galileo.sh`](../script/bootstrap-createx-galileo.sh). A line about this in
  the Galileo docs would save every deterministic deployer the same discovery.
- **0G publishes no Chainlink feed and no Circle USDC**, so a payments deploy stands up an
  EIP-3009-faithful mock USDC plus a `$1` `MockV3Aggregator` and states the mock at every quote:
  [`script/Seed0GGasless.s.sol`](../script/Seed0GGasless.s.sol).
- **Broker method names verified against SDK 0.9.0**, with the honest residual that our single-shot
  adapter threads no `chatID`, so billing correlation is approximate.
- **A measured context-window fact for a smaller model:** RAG grounding ran 6,479–9,660 bytes across
  five one-click questions, against roughly 130K tokens for the whole corpus. That ratio is the
  practical guidance we would have wanted in the inference docs.

**What we would change.** Lead the Compute docs with "fund a wallet", not "get a key". Say that CreateX
is absent and link the bootstrap. Thread a `chatID` through the single-shot path.

**Labels.** Chain deploy: **live** — broadcast record for 16602; verification and the mirror cutover are
pending. 0G Compute: **built, env-gated** — the SDK is absent from `node_modules` and no broker is
funded, so the path stays dormant. The SDK and `ethers` are optional peer deps behind an indirect
dynamic import, so the build is green without them.

---

## World — IDKit · Developer Portal verify

**What we use.** The `@worldcoin/idkit` widget and `POST /api/v4/verify/{rp_id}` —
[`web/lib/worldid/verify.ts`](../web/lib/worldid/verify.ts),
[`web/lib/worldid/config.ts`](../web/lib/worldid/config.ts),
[`web/lib/worldid/nullifierStore.ts`](../web/lib/worldid/nullifierStore.ts).

**What we learned that your docs do not say.**

- **Forward the IDKit result byte-for-byte; any field remap yields `verification_failed`.** We carry
  that as a comment at the seam so the next maintainer does not tidy it up into a mapped object —
  [`web/lib/worldid/verify.ts`](../web/lib/worldid/verify.ts).
- **Both v4 and legacy v3 nullifier shapes are in the wild**: `nullifier` top-level, or
  `responses[0].nullifier`. A migration note would help.
- **The portal proves a proof valid; one-human-per-action is the integrator's job.** That division of
  responsibility deserves a bold line in the docs, because the natural first implementation is an
  in-memory set — which survives no restart and is a replay vulnerability. Ours requires a durable
  `UNIQUE(namespace, key)` store and **fails closed to 503** in production absent one, rather than
  degrading into the vulnerable path: [`web/lib/worldid/nullifierStore.ts`](../web/lib/worldid/nullifierStore.ts),
  [`web/lib/security/replayStore.ts`](../web/lib/security/replayStore.ts).
- **The real-vs-simulator switch is the sharpest edge here.** Anything other than `"production"` runs
  the staging simulator, which is not a real proof of personhood —
  [`web/lib/worldid/config.ts`](../web/lib/worldid/config.ts). In our own deploy that variable was
  documented in `.env.example` yet undeclared in the config registry, so the deploy dropped it silently
  and a locally-flipped setting never reached the live site. A "this is the simulator" banner in the
  IDKit widget itself would have caught it in a second.

**What we would change.** Make the simulator visually unmistakable in the widget. Put nullifier
durability in the quickstart, not in a security appendix.

**Labels.** **Built, env-gated** — `NEXT_PUBLIC_WORLD_APP_ID` and `WORLD_SIGNING_KEY` unset means
checkout degrades to standard and never blocks a payment. Nullifiers are normalized hex → `BigInt` →
base-10 before storage.

---

## Ledger + the Ethereum Foundation — ERC-7730 · ERC-8213

**What we use.** An ERC-7730 descriptor for the router, one descriptor bound across mirror chains via
`context.contract.deployments[]`, plus ERC-8213 calldata-digest helpers in `@access0x1/react`:
[`clear-signing/erc7730-access0x1-router.json`](../clear-signing/erc7730-access0x1-router.json),
[`clear-signing/README.md`](../clear-signing/README.md),
[`packages/react/src/clearSigning.ts`](../packages/react/src/clearSigning.ts).

**What we learned that your docs do not say.**

- **A generic decode is not enough, and the failure is field-shaped.** `usdAmount8` is an 8-decimal USD
  *price*, not a token amount — rendering it as `tokenAmount` shows a meaningless native-coin figure,
  which is the exact "less alarming hex" trap clear signing exists to close. It renders via `unit` with
  `base:"$"`, `decimals:8`, `prefix:true`. `feeBps` renders as a `bps` unit rather than a bare integer.
  `maxStaleness` renders as seconds. Overloaded `setPriceFeed(address,address)` versus
  `(address,address,uint256)` disambiguate by full signature. All of it in
  [`clear-signing/README.md`](../clear-signing/README.md).
- **The maintenance rule that keeps a descriptor honest belongs in the spec's guidance:** regenerate the
  flat ABI from the compiled artifact (`jq '.abi' out/…`), never hand-edit, and run `erc7730 lint`
  before submission. A hand-edited descriptor drifts from the deployed ABI without any signal.
- **ERC-8213 works as specified.** `keccak256(uint256(len) ‖ calldata)`, `chainId` deliberately excluded
  because the digest commits to the call rather than the network; cross-checked against Foundry's
  `cast keccak` in [`packages/react/src/clearSigning.test.ts`](../packages/react/src/clearSigning.test.ts).

**What we would change.** Add a worked "this field is a price, not an amount" example to the ERC-7730
format docs — it is the mistake most likely to ship. Say in the registry contribution guide that the
ABI must be generated, not authored.

**Labels.** **Built.** The descriptor is in-repo and all 20 function signatures are cross-checked
against the compiled ABI; its `deployments[]` array lists nine mirror-chain entries. Registry
submission and an ERC-8176 attestation are operator decisions and are **not** done — we make no claim
of being in the registry.

---

## MetaMask — Snaps · ERC-7715 / ERC-7710

**What we use.** A Snap using `onTransaction`, `onRpcRequest`, `manageState` (encrypted) and the
`transaction-insight` permission, plus an ERC-7715 / ERC-7710 serializer over our on-chain
`SessionGrant`: [`snap/README.md`](../snap/README.md),
[`snap/src/branding/sanitize.ts`](../snap/src/branding/sanitize.ts),
[`web/lib/erc7715/permissions.ts`](../web/lib/erc7715/permissions.ts).

**What we learned that your docs do not say.**

- **A 7715 permission does not map cleanly onto an on-chain grant, and the honest thing is to say which
  field does not map.** `SessionGrant` is a pure authorization ledger — it stores budget, expiry,
  delegate and nonce, and **not** the token. So `permission.data.token` is carried as interop metadata
  and surfaced on the descriptor, rather than pretending the grant enforces denomination. The full
  field-by-field table, including that gap, is at
  [`web/lib/erc7715/permissions.ts`](../web/lib/erc7715/permissions.ts). A "what your context blob must
  and must not claim" section in the 7715 docs would make more adapters honest.
- **The opaque 7715 `context` needs a worked example.** Ours is `abi.encode(address sessionGrant,
  bytes32 sessionId)`, spelled out at the same path.
- **Untrusted metadata reaches wallet UI through this surface.** Merchant name, colour and logo SVG
  arrive over `wallet_invokeSnap` from a hosted page. We bound and sanitize all of it before storage or
  render — rejecting `<script>`, event handlers, `javascript:` / `data:text/html` URLs,
  `<foreignObject>` and external references — rather than trusting the downstream `<img>` sandbox
  alone: [`snap/src/branding/sanitize.ts`](../snap/src/branding/sanitize.ts). A sanitization checklist
  in the Snaps UI docs would be worth more than a warning sentence.

**What we would change.** Publish a reference `context` encoding. Add an untrusted-metadata section to
the Snaps custom-UI guidance.

**Labels.** Snap: **built, not published** — it is in-repo, it holds no keys and no funds, and it never
hardcodes the router address (the dapp sets it via `configure`). The 7715/7710 adapter: **built** —
a pure serializer, no money path, no env read. The on-chain 7710 redemption facade is explicitly
marked **deferred**, not implied.

---

## Dynamic — embedded wallets · MPC server wallet

**What we use.** `@dynamic-labs/sdk-react-core`, `@dynamic-labs/ethereum`,
`@dynamic-labs/wagmi-connector`, and `@dynamic-labs-wallet/node-evm` for the server MPC wallet, plus
JWT issuer/audience verification: [`web/lib/dynamic.ts`](../web/lib/dynamic.ts),
[`web/lib/agent/dynamicAgentWallet.ts`](../web/lib/agent/dynamicAgentWallet.ts).

**What we learned that your docs do not say.**

- **`theme` is a sibling of `settings`, not a setting.** Passing the dark palette inside `settings`
  leaves the modal flashing a white sheet over a dark app. That one-line placement fact costs an hour.
  Recorded at [`web/lib/dynamic.ts`](../web/lib/dynamic.ts).
- **The shadow-DOM CSS variables that actually ship** are `--dynamic-base-1..4`,
  `--dynamic-border-color` and `--dynamic-brand-primary-color` — grepped from the installed package
  rather than found in docs. Publishing the list would remove the grep.
- **`AuthMode` is exactly `'connect-only' | 'connect-and-sign'`**, verified against the installed
  `@dynamic-labs/types`, and the reason to prefer `connect-and-sign` deserves stating: it pairs the
  connection with an ownership signature, so the session is an authenticated user rather than a
  connected address.
- **`SortWallets` reorders and never hides** — worth one sentence, because the name reads like a filter.
- **Email and social must also be switched on in the environment dashboard.** Code alone does not
  enable them, and the failure mode is a modal that silently offers fewer options.
- **A config-registry lesson that is ours, not yours, but it bit at this seam:** the agent server wallet
  reads `WALLET_PASSWORD`, which had been grouped under the wrong integration, so the setup prompt never
  asked for it and the wallet failed at boot on a variable the operator was never shown.

**What we would change.** Document `theme` placement next to the palette variables. Publish the CSS
variable list.

**Labels.** Merchant sign-in: **live** on the deployed app. MPC agent wallet: **built, env-gated**.

---

## Mysten / Walrus — blob publish + aggregator read

**What we use.** The stateless HTTP daemons — `PUT /v1/blobs` (publisher), `GET /v1/blobs/{blobId}`
(aggregator) — plus `epochs`: [`web/lib/walrus.ts`](../web/lib/walrus.ts),
[`web/scripts/publish-checkout.mts`](../web/scripts/publish-checkout.mts).

**What we learned that your docs do not say.**

- **The publish response has two shapes and only one carries a Sui object id.** `newlyCreated` and
  `alreadyCertified` — a client written against the first breaks the first time anybody re-publishes
  identical bytes, which in a CI pipeline is the second run. We normalize both behind one
  `PublishResult`, and the parser is pure so both shapes are unit-tested offline:
  [`web/lib/walrus.ts`](../web/lib/walrus.ts) (`parsePublishResponse`). Showing both shapes side by side
  in the publisher docs would close this.
- **Testnet blobs are best-effort and garbage-collectable**, so a permanence claim on testnet is simply
  wrong. Anything durable needs a funded publisher and WAL, which is why no mainnet endpoint ships as a
  default here.

**What we would change.** Put both response shapes in the API reference. Say on the testnet page that
blobs are collectable, in those words.

**Labels.** **Built, env-gated / manual** — publishing is an operator step and `@mysten/walrus` is absent
from `node_modules`. Stated boundary: this code does no Sui signing, pays no WAL, and manages no epochs.

---

## 1inch — Swap API v6

**What we use.** `/quote` (GET, `src` / `dst` / `amount` / `fee=0`), a Fusion-versus-classic execute
branch, and an EXACT_INPUT agent quote seam: [`web/lib/payout-swap/rails/oneInch.ts`](../web/lib/payout-swap/rails/oneInch.ts),
[`web/lib/agent/anyToken1inch.ts`](../web/lib/agent/anyToken1inch.ts).

**What we learned that your docs do not say.** The useful finding here is a negative result, written
down at length so nobody re-derives it: **the API serves no testnets**, so a testnet-only repo maps
**no chain** to it. A capability table is a public promise, and an entry for a chain the vendor does
not serve is an overclaim — we deleted our `polygonAmoy → 'one-inch'` row and left the reasoning in
place so nobody re-adds it: [`web/lib/payout-swap/capabilities.ts`](../web/lib/payout-swap/capabilities.ts).
We also record that our quote leg matches v6 while our execute leg still parses a `txHash` the API
never returns, so it needs a signer before any use.

**What we would change.** State testnet coverage (or its absence) on the API landing page rather than
leaving it to be discovered per chain.

**Labels.** **Designed** — real client code, mapped to no chain, dormant without `ONEINCH_API_URL`,
never proven against a live endpoint from this repo.

---

## Hedera — EVM via the Hashio relay

**What we use.** Hedera EVM (296) through the Hashio JSON-RPC relay:
[`web/lib/chains.ts`](../web/lib/chains.ts), [`docs/CHAIN-ADDRESSES.md`](CHAIN-ADDRESSES.md).

**What we learned that your docs do not say.** Mostly your docs *do* say it, and we were the ones who
had it wrong — so this entry is a correction preserved in the source rather than a complaint. An
earlier comment in this repo asserted Hedera had no Chainlink feeds. Hedera documents them via the
Price Feeds Adapter; Pyth and Supra are documented too, and Supra publishes HBAR/USD. What stays
unverified is whether a **USDC/USD feed exists on testnet 296**, so the `$1` mock stays and the claim is
not made. Separately, the practical operating fact worth surfacing louder: **Hashio is explicitly
development-and-testing only and rate-limited** — roughly 50 HBAR/min globally plus 100–1,600 requests
per IP per minute by tier — which makes any shared-IP venue a real failure mode. A second public relay
for 296 exists and is named in our chain config as a fallback.

**What we would change.** Put the per-IP rate limits next to the relay URL, not in an operations page.

**Labels.** **Designed** — config-ready, no `broadcast/…/296` record, so no deployment is claimed.

---

## Zircuit — Garfield testnet

**What we use.** Garfield (48898) chain config plus a `make deploy-zircuit-garfield` target:
[`web/lib/chains.ts`](../web/lib/chains.ts).

**What we learned that your docs do not say.** The pricing consequence stated where a deployer will
read it: Zircuit uses Redstone/API3 rather than Chainlink, so our router's direct `AggregatorV3` path
does not apply and the swappable [`PriceOracleAdapter`](../src/PriceOracleAdapter.sol) is the route.
That mapping — "which oracle stack, therefore which integration path" — is what an EVM-compatible chain
page most often omits. Ours is in [`docs/CHAIN-ADDRESSES.md`](CHAIN-ADDRESSES.md).

**What we would change.** Add an "oracles available here" line to the chain quickstart.

**Labels.** **Designed** — the target is ready and the chain is in `SUPPORTED_CHAINS`; there is no
`broadcast/…/48898` record.

---

## CreateX — the deterministic factory the whole address story rests on

**What we use.** CreateX is what makes one router address the same on every chain we deploy to. Every
mirror address in this repo depends on it.

**What we learned that your docs do not say.** The distribution mechanism is the part integrators get
wrong: CreateX is **not** deployed through the `0x4e59` deterministic-deployment-proxy. It ships as an
official pre-signed, keyless transaction from a fixed one-time deployer EOA, so landing it on a new
chain is "fund the deployer EOA once, then anybody can broadcast the self-funded tx" (~2.58M gas, on any
chain with Ethereum-equivalent gas metering). We wrote that method out as a runnable script for the one
chain in our set where CreateX is absent:
[`script/bootstrap-createx-galileo.sh`](../script/bootstrap-createx-galileo.sh).

**What we would change.** Nothing about the mechanism — it works. A canonical
"here is how to bring CreateX to a chain that lacks it" page would save the derivation.

**Labels.** **live** — the CREATE3 mirror at `0xe92244e3368561faf21648146511DeDE3a475EB5` exists because
of it.

---

## foundry-zksync / Matter Labs — a reproducible tooling defect

**What we use.** `forge build --zksync` for the EraVM path, and the standard `DeployAll` script on
every EVM chain.

**What we learned that your docs do not say.** This is a clean upstream bug report with a proposed fix,
already written up at [`docs/ZKSYNC-TESTING.md`](ZKSYNC-TESTING.md). Root cause: **cheatcodes work only
at the script root, never inside a CREATE or CALL dispatched to the zkEVM.** `HelperConfig`'s
constructor calls `vm.envAddress`, and under `--zksync` that constructor runs in the zkEVM, so the
cheatcode dies with `call may fail … due to empty code target=0x7109…12d` and `Invalid opcode, Not
enough gas` — an error pair that names neither cheatcodes nor the root-only rule. The fix on our side
is to read env at the script root and pass values in. The fix on yours is a clearer diagnostic.

Second finding, stated as a rule because it is the one that costs the most: **`forge test` runs on the
EVM, not the zkEVM. EVM-green does not mean zkSync-green.**

**What we would change.** Make the error message name the cheatcode-at-root restriction. Say the
EVM/zkEVM test-target difference on the first page of the zksync docs.

**Labels.** The zkSync Sepolia (300) deploy went out through the dedicated EraVM path and is recorded in
`broadcast/…/300`; source verification there is pending.

---

## OIDC providers (Google, Auth0, Okta, Keycloak, self-hosted)

**What we use.** `jose` ID-token verification with a configurable issuer, JWKS URL and audience:
[`web/lib/oidc/config.ts`](../web/lib/oidc/config.ts), `web/app/api/oidc/verify`.

**What we learned that your docs do not say.** **The audience is the real switch, and most setup guides
bury it.** A guide that says "set the issuer and you are verifying" invites the exact failure this
seam refuses: accepting a token minted for some other application. A blank audience makes our route
report `not_configured` and it never accepts an unaudienced token. The issuer and JWKS URL have safe
public defaults; the audience is the single gate.

**What we would change.** Make "pin the audience" step one of every OIDC integration guide.

**Labels.** **Built, env-gated.**

---

## AP2 / A2A — agent mandates and the agent card

**What we use.** An AP2 mandate chain and an A2A Agent Card at `/.well-known/agent-card.json`:
[`web/lib/ap2/mandate.ts`](../web/lib/ap2/mandate.ts), [`web/lib/ap2/README.md`](../web/lib/ap2/README.md).

**What we learned that your docs do not say.**

- **The mandate chain is hash-bound, and that property is verifiable with no key at all.**
  `boundTo.contentDigest` is a sha-256 over the canonical JSON of the bound-to mandate, so
  `verifyChainLinks()` detects tampering at any level without a signature — tampering breaks the next
  level's digest. Worth naming as a distinct guarantee in the spec, separate from the JWS.
- **Bounds belong at build time.** A cart whose items do not sum, a cart over remaining budget, and a
  payment that does not equal the cart total all throw at construction rather than at verification.
- **The framing that keeps the whole thing honest:** the VC is a wire format; the on-chain
  `SessionGrant.remaining(sessionId)` is the truth a distrusting counterparty reads. A spec section on
  "what the credential is not" would prevent a class of over-trusting integrations.

**What we would change.** Split the no-key chain-integrity guarantee out from the signature section.

**Labels.** **Built** — pure derivation, no money moves, no secret read. Standard W3C VC / AP2 / A2A
shapes wrapped around a bespoke on-chain grant, and we say which half is which.

---

## RPC providers (QuickNode and any HTTPS endpoint)

**What we use.** Per-chain endpoints via `RPC_URL_<id>` server-side and `NEXT_PUBLIC_RPC_URL_<id>` in
the browser: [`web/lib/chains.ts`](../web/lib/chains.ts),
[`web/lib/config/integrations.ts`](../web/lib/config/integrations.ts).

**What we learned that your docs do not say.** This one is a Next.js rule with money consequences, and
it deserves to be in every "add your RPC URL" quickstart: **a computed `..._${chainId}` env key never
inlines**, so the browser sees `undefined` even with the value correctly set. Every documented checkout
chain therefore gets a literal key, and a blank value normalizes to `undefined` via `|| undefined` so an
empty variable can never shadow a working default. Both facts at
[`web/lib/chains.ts`](../web/lib/chains.ts).

**What we would change.** Add the literal-key requirement to the Next.js sections of RPC onboarding docs.

**Labels.** **live** wherever an endpoint is set; **built, env-gated** otherwise, falling back to
rate-limited public defaults.

---

## Anthropic — the inference seam

**What we use.** `@anthropic-ai/sdk` behind the same `runInference` seam as every other backend:
[`web/lib/ai/inference.ts`](../web/lib/ai/inference.ts), `web/app/api/docs-ask/route.ts`.

**What we learned that your docs do not say.** Nothing about the API itself. The finding is a seam
design other integrators can copy: one env switch, a per-request override, a third override read from
an ENS text record (`click.access0x1.inference`), and an `x-inference-provider` response header so the
UI never claims a backend that did not answer.

**Labels.** **live** for the docs assistant, env-gated on `CLAUDE_API_KEY`.

---

## The rules we hold ourselves to

1. **Every seam stays env-gated and removable.** Blank config is a clean no-op, never a blocked
   payment. That is what keeps an integration an honest recommendation rather than a lock-in, and it
   means your outage is not our users' outage.
2. **No claim ships without its proof.** A deployed address comes from a committed broadcast record, a
   count comes from a fresh run, and **deployed / verified / usable** are three different words.
3. **A negative result gets written down.** The 1inch non-entry and the Hedera feed correction are here
   for the same reason the working integrations are: a reference implementation that teaches a wrong
   pattern is worse than no reference at all.
4. **Corrections outrank compliments.** Tell us the integration is wrong and how, and it gets fixed.

Related reading: [`FEEDBACK.md`](../FEEDBACK.md) — upstream asks scored one by one, including one
marked RETIRED because we had been wrong. [`docs/OPTIONAL-SEAMS.md`](OPTIONAL-SEAMS.md) — how each seam
is wired and disabled. [`docs/CHAIN-ADDRESSES.md`](CHAIN-ADDRESSES.md) — every address with its
first-party source.
