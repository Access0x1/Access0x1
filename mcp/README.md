# @access0x1/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets any
AI agent operate the Access0x1 payments rail — **with zero hardcoded chain facts.**

Your assistant reads the rail's manifest at runtime, so **addresses are data, not
code.** The server itself carries no router, USDC, or feed address anywhere in its
source. It learns them the moment it starts, from whatever manifest you point it
at. Chains get added, addresses get corrected, a new testnet comes online — your
agent picks all of that up on the next run, with nothing to re-ship and nothing to
copy-paste from a doc that may already be stale.

Two things this gives you:

1. **Save time, never hardcode.** One manifest is the single source of truth for
   chain addresses. The agent asks the rail where things are instead of guessing.
2. **A payments toolbox for assistants.** An integrator app's assistant drives the
   rail through eight small, well-described tools — discover chains, read a
   merchant, confirm a payment landed, hand over a checkout link, or make a
   budget-scoped payment.

## Install

```sh
npm install @access0x1/mcp
```

Requires Node ≥ 20.

## Configure

Every external fact comes from an environment variable — the package ships **no**
addresses. Set the manifest source (required) and turn on the optional capabilities
you want.

| Variable | Required | Purpose |
|---|---|---|
| `ACCESS0X1_MANIFEST_PATH` | one of these two | Local JSON manifest file. Highest priority. |
| `ACCESS0X1_MANIFEST_URL` | one of these two | Raw JSON manifest URL. Used when the path is unset or unreadable. |
| `ACCESS0X1_SUBGRAPH_URL` | optional | Indexed payment-history endpoint. Unset → the indexed-history tools report **dormant**. |
| `ACCESS0X1_WEB_BASE_URL` | optional | The rail web app base origin (hosted checkout + agent-pay route). Unset → `checkout_link` and `agent_pay_request` report **dormant**. |
| `ACCESS0X1_AGENT_INTERNAL_SECRET` | optional | Shared caller-auth token forwarded to the agent-pay route. **Not** a spending key — the web route owns the wallet and the budget. Never logged or echoed. |

At least one manifest source is mandatory. The server refuses to start without one,
because it never falls back to hardcoded addresses. When both are set, the local
path is tried first and the URL is the fallback.

### Register with an MCP host

Point your host (Claude Desktop, Claude Code, or any MCP client) at the `stdio`
binary:

```json
{
  "mcpServers": {
    "access0x1": {
      "command": "npx",
      "args": ["-y", "@access0x1/mcp"],
      "env": {
        "ACCESS0X1_MANIFEST_URL": "https://raw.githubusercontent.com/<org>/<repo>/main/mcp/manifest/access0x1.testnet.example.json"
      }
    }
  }
}
```

An example testnet manifest ships in the package at
`manifest/access0x1.testnet.example.json` — illustrative and non-authoritative,
built from real testnet facts so the server runs out of the box. Point
`ACCESS0X1_MANIFEST_URL` at the rail's own published manifest for production use.

## Tools

### Read tools — never move funds

| Tool | Arguments | Returns |
|---|---|---|
| `list_chains` | — | Every chain in the manifest: id, name, router, verified flag. **Call this first.** |
| `chain_facts` | `chainId` | Router, USDC, native/USD + USDC/USD feeds, explorer base + router link, RPC. A fact the manifest omits comes back `null` — never guessed. |
| `merchant_lookup` | `merchantId` \| `ownerAddress` | A merchant's indexed aggregate (owner, payout, fee, active, payment count, cumulative USD), with `asOfBlock` + indexer health. |
| `merchant_payments` | `merchantId`, `limit?` | A merchant's most-recent settled payments, newest first, with `asOfBlock` + indexer health. |
| `network_leaderboard` | `limit?` | Top merchants across the whole rail by indexed USD volume, with `asOfBlock` + indexer health. |
| `verify_payment` | `merchantId`, `minUsd?`, `maxAgeSeconds?` | A typed verdict ("has a qualifying payment landed?") plus the reasoning, `asOfBlock`, and `indexingHealthy`. Degrades to **not verified** on any index problem. |
| `checkout_link` | `merchantId`, `amountUsd?`, `chainId?` | A hosted-checkout URL a buyer opens to pay. Pure URL construction — no network call, no funds move. |

### Action tool — can move funds via the rail's own budgeted route

| Tool | Arguments | Returns |
|---|---|---|
| `agent_pay_request` | `merchantId`, `usdAmount`, `resourceUrl`, `count?` | Shapes and POSTs the rail's `/api/agent/pay` request and forwards the route's own response. **This server holds no keys** — the web route owns the wallet, the spend meter, the URL allowlist, and caller-auth. |

Every result carries a `provenance` stamp naming where the fact came from — the
manifest (with the source it was loaded from), the subgraph (endpoint redacted, so
a hosted indexer URL never leaks a query key), or the web base URL.

## The honesty signals

Indexed reads surface two fields, and your agent reads them before trusting a
number:

- **`asOfBlock`** — the indexer's synced block height. Present it as "as of block
  N"; a count without a block is unlabelled.
- **`indexingHealthy` / `hasIndexingErrors`** — whether the index is trustworthy
  right now. `verify_payment` returns `verified: false` whenever the index is
  degraded, absent, or behind — absent data is treated as a reason to withhold,
  never as goodwill.

A **dormant** result means an optional capability is switched off for this
deployment (an env var is unset) — the agent proceeds as though the tool had no
opinion. An **error** result means the capability is configured but the specific
call could not complete. Those are deliberately distinct.

## Integrator example: a booking assistant

A booking assistant confirms a reservation that a customer paid on-chain. Before it
writes "confirmed," it checks that the payment actually landed:

```ts
// The assistant already knows the merchant id it is booking against.
const decision = await callTool('verify_payment', {
  merchantId: '49',
  minUsd: 25,       // the reservation costs $25
  maxAgeSeconds: 3600,  // and must have been paid within the last hour
});

// decision.structuredContent:
// {
//   verified: true,
//   indexingHealthy: true,
//   asOfBlock: "43900000",
//   reasoning: [
//     "as of block 43900000",
//     "indexer healthy: no indexing errors reported",
//     "payment count 7 meets the >= 1 minimum",
//     "indexed volume $5.00 meets the >= $25.00 minimum",   // <- would fail here
//     "last payment ~0d ago is within the 0d recency window",
//     "..."
//   ]
// }
```

The assistant confirms the booking **only** where `verified` and `indexingHealthy`
are both true, and cites the block: "Payment confirmed as of block 43900000." On
any other outcome it reads back the failing `reasoning` line and asks the customer
to wait for the index to catch up or to complete payment — it never confirms on a
number it cannot stand behind. To collect a fresh charge instead, it builds a link
with `checkout_link({ merchantId: '49', amountUsd: 25 })`.

## Develop

```sh
npm run typecheck   # tsc --noEmit (strict)
npm run test        # vitest
npm run gate        # typecheck + test
npm run build       # emit dist/
npm start           # run the stdio server (needs a manifest env)
```

The whole tool layer is unit-tested with injected file/fetch/clock seams — no real
network, filesystem, or wall clock — plus an in-memory MCP client/server round-trip
that exercises every tool over the real transport.

## License

MIT.
