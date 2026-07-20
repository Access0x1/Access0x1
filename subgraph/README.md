# Access0x1 subgraph — payment history (open analytics)

A [The Graph](https://thegraph.com) subgraph that indexes the **public**
`Access0x1Router.PaymentReceived` event into a queryable payment history +
per-merchant totals. It is **protocol-level, open infrastructure**: anyone
integrating Access0x1 can query it. The Access0x1 dashboard reads router events
directly on-chain today (`web/lib/contracts.ts`); it *can* switch to this subgraph
for a payments view once the query proxy + Studio key are wired — this subgraph is
the ready integration point (now retargeted to the mirror router), not yet a live
dependency of the dashboard.

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

## Cost (no-cost tier)

Deploying via **Subgraph Studio has no cost**; querying is **at no cost up to 100,000
queries/month**, then usage-based (~$2 / 100k on The Graph's own pricing). For the
dashboard's traffic that is effectively at no cost. This is The Graph's external cost, not
an Access0x1 charge — the open protocol indexes a public event and adds nothing on top.

## Layout

```
subgraph/
├── subgraph.yaml          # manifest — mirror router on Base Sepolia, startBlock = mirror creation block
├── schema.graphql         # Payment (immutable) + Merchant (identity + running totals) + MerchantToken
├── src/mapping.ts         # PaymentReceived → Payment + aggregates; Merchant{Registered,Updated,OwnerTransferred} → identity
└── abis/Access0x1Router.json
```

Indexes **Base Sepolia**, targeting the **CREATE3-mirror router**
`0xe92244e3368561faf21648146511DeDE3a475EB5` (the same address on every mirrored
chain), from its creation block **43188206** (live-verified by `eth_getCode` binary
search; the mirror was CREATE3-deployed outside this repo's broadcast history, so
re-verify the block with `cast code`, not a broadcast grep). **Retargeted here
2026-07-11** from the pre-mirror router `0xec89…8e57`: the repoint condition — the
mirror carrying merchants + settled history — has been met since 2026-07-08 (real
`MerchantRegistered` @ block 43890853 and `PaymentReceived` @ 43895166). It now
indexes the full merchant lifecycle (registration, config updates, and the 2-step
owner transfer) alongside payment history. Arc (`5042002`) is not a Graph-supported
network today, so Arc payment history is read directly on-chain until/if The Graph
adds Arc.

## Build + deploy (no-cost Subgraph Studio)

```sh
cd subgraph
npm install
npm run codegen        # generate AssemblyScript types from the ABI + schema
npm run build          # compile the mappings to WASM (validates everything)
# then, with a no-cost Studio account:
npm run auth <deploy-key>     # one-time, from https://thegraph.com/studio
npm run deploy                # publishes to your Studio subgraph
```

`codegen` + `build` validate the subgraph offline; `auth` + `deploy` need a
Studio account (no-cost tier; owner step). No mainnet, testnet only.

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
