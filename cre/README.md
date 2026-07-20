# Access0x1 — Notified Settlement (Chainlink CRE workflow)

The off-chain half of the **Notified Settlement** feature. A Chainlink CRE workflow watches the
router's on-chain `PaymentReceived` log and, on every settlement, (a) **HTTP-notifies the merchant**
webhook and (b) writes an **on-chain audit entry** to [`Access0x1Receiver`](../src/Access0x1Receiver.sol)
via the KeystoneForwarder. The on-chain write is the state change that clears the CRE judging bar:
*an orchestration layer integrating a blockchain with an external API/system.*

```
Access0x1Router.PaymentReceived (EVM-log trigger)
        │
        ▼
   CRE workflow (TS SDK → WASM, DON consensus)
        ├─ (a) HTTP POST → merchant settlement webhook        [external API]
        └─ (b) evmClient.writeReport → KeystoneForwarder → Access0x1Receiver.onReport  [on-chain]
```

## ⚠️ Status: BUILD + SIMULATE — this is NOT a live deploy

CRE **deploy is Chainlink Early-Access** (approval-gated; a `cre whoami` shows
`Deploy Access: Not enabled`). The path that works at the event without that access — and the honest
claim for the submission — is **build + simulate**:

```bash
cd cre
npm install                          # pulls @chainlink/cre-sdk (+ viem); build-session step, not CI
cre login                            # no cost to sign in
cre workflow build                   # compiles workflow.ts → WASM (Javy/QuickJS)
cre workflow simulate                # runs the workflow against real public-EVM + real HTTP calls
cre workflow simulate --broadcast    # also sends the on-chain audit write to the sim MockForwarder
```

**For judges:** the prize rule permits *"build, simulate, OR deploy"*; the submitted artifact is
**built + simulated** and qualifies for full points. A live deploy would require Chainlink
Early-Access approval, which is gated and not expected at the event — so the absence of a live deploy
is not a gap. The honest artifact is **"built + simulated."** Do **not** claim a self-served live
deploy. (Booth question #3a: confirm whether the Chainlink team deploys the workflow to live CRE for
you at the event.)

## The trigger — exact ABI + topic0

The workflow's EVM-log trigger keys on the router's `PaymentReceived` event. The signature mirrors
[`Access0x1Router.sol`](../src/Access0x1Router.sol) byte-for-byte (do not reorder — the topic hash
and the decode both depend on it):

```solidity
event PaymentReceived(
    uint256 indexed merchantId,
    address indexed buyer,
    address indexed token,
    uint256 grossAmount,
    uint256 feeAmount,
    uint256 netAmount,
    uint256 usdAmount8,
    bytes32 orderId,
    uint64  srcChainSelector
);
```

- **Canonical signature:** `PaymentReceived(uint256,address,address,uint256,uint256,uint256,uint256,bytes32,uint64)`
- **topic0 (keccak256 of the signature):**
  `0x0e7e4f9badfadd9437d5fe53bdba0ca985b1b3414cb35b09a4459416e1735eea`

`workflow.ts` recomputes topic0 with viem's `toEventHash` and uses it as the `logTriggerConfig`
`topics[0]` filter, scoped to `config.routerAddress`, at `FINALIZED` confidence.

## The on-chain write — AuditEntry

The handler ABI-encodes one `Access0x1Receiver.AuditEntry` tuple as the report body (field order
matches the Solidity struct exactly) and `writeReport`s it via the KeystoneForwarder:

```
tuple(uint256 merchantId, address token, uint256 grossAmount, uint256 usdAmount8,
      bytes32 orderId, uint64 srcChainSelector, uint64 notifiedAt)
```

`notifiedAt` is `runtime.now()` (DON-consensus time) in unix seconds — **never** `Date.now()`.

## Files

| File | What |
|---|---|
| `workflow.ts` | The workflow: EVM-log trigger on `PaymentReceived` → HTTP notify + `writeReport` audit. |
| `config.ts` | Zod `configSchema` + the `NotifyConfig` type the runner validates `config.json` against. |
| `config.json` | Per-run values (chain + router/receiver addresses + webhook URL + secret ID). SIMULATE placeholders; **no secret values**. |
| `workflow.yaml` | CRE CLI manifest: workflow name, the TS entrypoint, the config + secrets paths. |
| `tsconfig.json` | Strict TS config for `npm run typecheck` (`tsc --noEmit`). |
| `package.json` | `@chainlink/cre-sdk` + `viem` deps + `build` / `simulate` / `typecheck` scripts. |

> `npm run typecheck` (and `cre workflow build`/`simulate`) require `npm install` here first — the
> CRE SDK install is a build-session/owner action and is intentionally **not** part of the contract
> gate. The TypeScript type-checks clean against the installed SDK (v1.11).

## Determinism (mandatory — or DON consensus fails)

The WASM runtime is **Javy (QuickJS)**, not Node: `node:crypto`, `fetch`, `setTimeout`, and
`Date.now()` are unavailable. Accordingly:

- Time comes from `runtime.now()` (DON-consensus `Date`), never `Date.now()`.
- All amounts are `bigint` (the event args decode as `bigint` via viem); the webhook body serializes
  them as decimal strings — **no JS floats**.
- The webhook body has stable key order so every DON node produces a byte-identical body, and the
  HTTP call is reduced to a single value with `consensusIdenticalAggregation`.

## Supported networks (CRE)

Base + Base Sepolia ✓ · zkSync Era + Sepolia ✓ · **Arc Testnet 5042002** ✓ (chain selector name
`arc-testnet`; needs CLI ≥ 1.0.7 / TS SDK ≥ 1.3.1 — `cre update`). No Arc **mainnet** on CRE — fine,
the event is testnet. Arc-Testnet KeystoneForwarder (prod):
`0x76c9cf548b4179F8901cda1f8623568b58215E62` (the address the `Access0x1Receiver` constructor trusts
on Arc). The workflow resolves the selector at runtime via
`getNetwork({ chainFamily: 'evm', chainSelectorName, isTestnet: true })`.

## Off the money path — by construction

This workflow only **reads** `PaymentReceived` and **writes** to the standalone `Access0x1Receiver`.
It never calls `Access0x1Router`, never awaits/blocks settlement, never rolls anything back. The
router emits the event fire-and-forget; settlement is byte-for-byte identical whether CRE runs or not.

## Secrets

The merchant webhook auth key is referenced **by ID** (`config.webhookSecretId`) and pulled from the
CRE secrets vault at runtime (`runtime.getSecret({ id }).result().value`, sent as a `Bearer` header)
— never committed, never inlined. `config.json` carries only public placeholders; a local
`secrets.yaml` for `cre workflow simulate` is **gitignored** so a key value can never be committed.
