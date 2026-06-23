# Access0x1 subgraph — payment history (open analytics)

A [The Graph](https://thegraph.com) subgraph that indexes the **public**
`Access0x1Router.PaymentReceived` event into a queryable payment history +
per-merchant totals. It is **protocol-level, open infrastructure**: anyone
integrating Access0x1 can query it; the Access0x1 dashboard (and any integrating
app) reads it for a payments view.

## Why it's safe to depend on (and why it isn't a dependency)

- **Off the money path.** It only *reads* emitted events. Settlement never waits
  on it; if The Graph is unavailable, payments are unaffected and a client can
  fall back to reading the router's events directly on-chain. Non-dependency by
  design — the same posture as every Access0x1 sidecar (CRE audit, receipts).
  Each `Payment` row carries its `orderId`, so a client reconciles a specific
  payment by that key — the same binding `@access0x1/react`'s `usePayment` uses to
  match a `PaymentReceived` log to *its own* order (it races a 120 s timeout rather
  than hanging if the log never arrives), whether the source is this subgraph or a
  direct on-chain event read.
- **No secret in this package.** The manifest indexes a public contract address;
  the only credential is a Subgraph Studio **deploy/query key**, which is
  server-side env on the consumer, never in this repo.

## Cost (free tier)

Deploying via **Subgraph Studio is free**; querying is **free up to 100,000
queries/month**, then usage-based (~$2 / 100k on The Graph's own pricing). For the
dashboard's traffic that is effectively free. This is The Graph's external cost, not
an Access0x1 charge — the open protocol indexes a public event and adds nothing on top.

## Layout

```
subgraph/
├── subgraph.yaml          # manifest — Base Sepolia router, startBlock = deploy block
├── schema.graphql         # Payment (immutable) + Merchant (running totals)
├── src/mapping.ts         # handlePaymentReceived → Payment row + Merchant aggregate
└── abis/Access0x1Router.json
```

Indexes **Base Sepolia** (`0xec89c9eE28AF42Ae2b917BB0bAe245EAad6E8E57` — the
working pre-mirror Base Sepolia router that carries the live merchant and the demo
payment history; `networks.json` + `subgraph.yaml` pin it as the indexed source).
The CREATE3-mirror router (`0xe92244e3368561faf21648146511DeDE3a475EB5`, the same
address on every mirrored chain) is the canonical integration target; the manifest
is repointed there once that deploy carries the merchant + history to index. Arc
(`5042002`) is not a Graph-supported network today, so Arc payment history is read
directly on-chain until/if The Graph adds Arc.

## Build + deploy (free Subgraph Studio)

```sh
cd subgraph
npm install
npm run codegen        # generate AssemblyScript types from the ABI + schema
npm run build          # compile the mappings to WASM (validates everything)
# then, with a free Studio account:
npm run auth <deploy-key>     # one-time, from https://thegraph.com/studio
npm run deploy                # publishes to your Studio subgraph
```

`codegen` + `build` validate the subgraph offline; `auth` + `deploy` need a free
Studio account (owner step). No mainnet, testnet only.

## Example query

```graphql
{
  merchant(id: "0x31") {            # merchantId 1, UTF-8 encoded
    paymentCount
    totalUsd8
    payments(first: 10, orderBy: blockTimestamp, orderDirection: desc) {
      buyer
      token
      grossAmount
      netAmount
      usdAmount8
      transactionHash
    }
  }
}
```
