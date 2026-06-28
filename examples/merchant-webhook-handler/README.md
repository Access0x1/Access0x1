# Merchant webhook handler — consume the CRE audit stream

The [Chainlink CRE workflow](../../cre) "Notified Settlement" watches the router's
`PaymentReceived` log and, on every settlement, does two things: it **HTTP-POSTs the
merchant's webhook** and writes an immutable **on-chain audit entry** to
[`Access0x1Receiver`](../../src/Access0x1Receiver.sol). This example is the
**merchant side** of that webhook — a zero-dependency Node server that verifies the
bearer token, parses the settlement, and acks it exactly once.

Run it: [`server.mjs`](./server.mjs) (Node built-in `http` only — no `npm install`).

## Value flow

### Before — a payment settles on-chain; the merchant's backend doesn't know yet

```
Access0x1Router.PaymentReceived (log)        your backend
       (on-chain event)                       (no record)
```

### After — CRE bridges the chain to your API, and to an on-chain audit log

```
Access0x1Router.PaymentReceived (EVM-log trigger)
        │
        ▼
   CRE workflow (cre/workflow.ts → WASM, DON consensus)
        ├─ (a) HTTP POST  ──Bearer──▶  THIS server  ──▶ mark order paid, email receipt
        └─ (b) writeReport ──▶ KeystoneForwarder ──▶ Access0x1Receiver.onReport (on-chain audit)

   off the money path: the router emits fire-and-forget; settlement is identical whether CRE runs or not.
```

## The request the workflow sends

A POST with an `Authorization: Bearer <secret>` header and a **deterministic JSON
body** — fixed key order, all amounts as decimal **strings** (the DON serializes
`bigint`s as strings; there are no JS floats). This is byte-for-byte what
[`cre/workflow.ts`](../../cre/workflow.ts) emits:

```json
{
  "event": "PaymentReceived",
  "merchantId": "1",
  "buyer": "0x…",
  "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "grossAmount": "4500000",
  "feeAmount": "45000",
  "netAmount": "4455000",
  "usdAmount8": "450000000",
  "orderId": "0x6f726465722d636f666665652d30303031000000000000000000000000000000",
  "srcChainSelector": "0",
  "notifiedAt": "1719600000"
}
```

> Parse money with `BigInt` (or a decimal lib), **never** `Number()` — `grossAmount`
> can exceed `2^53`. The amounts are in the token's own base units (USDC = 6 dp);
> `usdAmount8` is the USD-8 price the buyer agreed to.

## What this handler does

| Concern | How |
| --- | --- |
| **Auth** | Constant-time `Bearer` check (`crypto.timingSafeEqual`). The workflow pulls the secret from the CRE vault by id and sends it as the bearer; you hold the matching value in `WEBHOOK_SECRET`. A wrong/absent token → `401`. |
| **Idempotency** | Keyed on `orderId`. The stream may retry; a repeat returns `200` with `duplicate-ignored` and re-acts on nothing. Production: a unique index on `orderId`. |
| **Off the money path** | It only records. It never calls the router, never blocks settlement — exactly mirroring the on-chain `Access0x1Receiver`. |

## Run

```sh
export WEBHOOK_SECRET=replace-with-the-value-behind-config.webhookSecretId
node server.mjs        # listening on http://localhost:8787/webhooks/access0x1
```

Send a sample settlement (in another shell):

```sh
curl -s -X POST http://localhost:8787/webhooks/access0x1 \
  -H "authorization: Bearer $WEBHOOK_SECRET" \
  -H "content-type: application/json" \
  -d '{"event":"PaymentReceived","merchantId":"1","buyer":"0x1111111111111111111111111111111111111111","token":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","grossAmount":"4500000","feeAmount":"45000","netAmount":"4455000","usdAmount8":"450000000","orderId":"0x6f726465722d636f666665652d30303031000000000000000000000000000000","srcChainSelector":"0","notifiedAt":"1719600000"}'
# → {"status":"recorded","orderId":"0x6f72…"}      (a second identical POST → "duplicate-ignored")
```

## Wiring the real stream

Point the workflow at this server: set `webhookUrl` (and the secret **id**) in
[`cre/config.json`](../../cre/config.json), put the secret **value** in a gitignored
`secrets.yaml`, then `cre workflow simulate` (see [`cre/README.md`](../../cre/README.md)).
Cross-check each webhook against the on-chain `Access0x1Receiver.AuditEntry` for the
same `orderId` — the immutable record is the source of truth.

> Status: the CRE workflow is **build + simulate** (deploy is Chainlink Early-Access);
> simulate exercises real public-EVM reads and real HTTP calls against this server.
