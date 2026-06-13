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
`Deploy Access: Not enabled`). The free path that works at the event — and the honest claim for the
submission — is **build + simulate**:

```bash
cd cre
npm install                      # pulls @chainlink/cre-sdk (build-session step; not run in CI)
cre login                        # free
cre workflow build               # compiles workflow.ts → WASM
cre workflow simulate            # runs the workflow against real public-EVM + real HTTP calls
cre workflow simulate --broadcast   # also sends the on-chain audit write to the sim MockForwarder
```

The prize rule is *"build, simulate, OR deploy"* — **simulate qualifies**. The honest artifact is
**"built + simulated."** Do **not** claim a self-served live deploy. (Booth question #3a: confirm
whether the Chainlink team deploys the workflow to live CRE for you at the event.)

## Files

| File | What |
|---|---|
| `workflow.ts` | The workflow: EVM-log trigger on `PaymentReceived` → HTTP notify + `writeReport` audit. |
| `config.ts` | Per-run config (chain, router/receiver addresses, webhook). SIMULATE placeholders by default; no secrets. |
| `tsconfig.json` | Strict TS config for `tsc --noEmit` once the SDK is installed. |
| `package.json` | `@chainlink/cre-sdk` dep + `build` / `simulate` / `typecheck` scripts. |

> Type-check (`npm run typecheck`) requires `npm install` first — the CRE SDK install is a
> build-session/owner action and is intentionally NOT part of the contract gate. Until then this is a
> documented, simulate-ready artifact.

## Determinism (mandatory — or DON consensus fails)

- Timestamps use `runtime.now()`, **never** `Date.now()`.
- All amounts are `bigint` (the event args decode as `bigint`); the webhook body serializes them as
  decimal strings — **no JS floats**.
- The webhook body has stable key order so every DON node produces byte-identical output.

## Supported networks (CRE)

Base + Base Sepolia ✓ · zkSync Era + Sepolia ✓ · **Arc Testnet 5042002** ✓ (needs CLI ≥ 1.0.7 /
TS SDK ≥ 1.3.1 — `cre update`). No Arc **mainnet** on CRE — fine, the event is testnet. Arc-Testnet
KeystoneForwarder (prod): `0x76c9cf548b4179F8901cda1f8623568b58215E62` (the address the
`Access0x1Receiver` constructor trusts on Arc).

## Off the money path — by construction

This workflow only **reads** `PaymentReceived` and **writes** to the standalone `Access0x1Receiver`.
It never calls `Access0x1Router`, never awaits/blocks settlement, never rolls anything back. The
router emits the event fire-and-forget; settlement is byte-for-byte identical whether CRE runs or not.

## Secrets

The merchant webhook signing key is referenced **by name** (`config.webhookSecretName`) and pulled
from the CRE secrets vault at runtime — never committed, never inlined. `config.ts` carries only
public placeholders.
