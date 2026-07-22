# @access0x1/x402-client

**IAgentPayer** — the minimal client an agent runtime uses to pay for a resource
through the Access0x1 rail via [x402](https://github.com/coinbase/x402). It is the
**payment leg only**: it does not decide *what* to fetch or reason about a task. Given a
resource, it discovers the 402 challenge, settles it through the rail, and returns the
paid result.

There is a behaviourally identical Python twin, `access0x1-x402-client`. One contract,
two languages — see `PARITY.md`.

## Install

```sh
npm install @access0x1/x402-client
```

## The flow

```
agent ──fetch(url)──▶ IAgentPayer
                        1. probe the resource            (the unpaid x402 request)
                        2. 402? parse + validate the x402 challenge   (accepts[])
                        3. POST url ▶ rail /api/agent/pay  (rail signs EIP-3009 USDC,
                                                            settles, retries internally)
                        4. return the paid result
```

The rail endpoint (`POST /api/agent/pay`) performs the payment and the paid retry
internally; the client discovers the challenge and delegates settlement. A non-402
response passes straight through unpaid.

## Usage

```ts
import { Access0x1Payer } from "@access0x1/x402-client";

// All configuration is explicit — the library reads no ambient env.
const payer = new Access0x1Payer({
  baseUrl: "https://pay.example.com",
  callerAuth: process.env.AGENT_INTERNAL_SECRET, // optional; sent as x-internal-secret
});

const out = await payer.fetch<{ report: string }>("https://api.example.com/premium");
if (out.paid) {
  console.log("paid by", out.agent, "→", out.result.report);
} else {
  console.log("no payment needed:", out.status, out.result);
}
```

### Settle in isolation

For a runtime that performed its own fetch and already holds the 402:

```ts
const settlement = await payer.settle({ url, challenge, pricePerCallUsd: 0.001 });
```

### Nano-loop

```ts
const settlement = await payer.settle({ url, count: 25, pricePerCallUsd: 0.001 });
console.log(settlement.results?.length); // 25 sequential micro-calls
```

## Error taxonomy

Every non-success money-path answer is **surfaced, never swallowed**:

| Error | Cause |
| --- | --- |
| `MalformedChallengeError` | A 402 whose body is not a valid x402 challenge — the payer refuses to pay and never reaches the rail. |
| `BudgetExceededError` | The rail rejected the spend on budget (`spent`, `cap` attached). |
| `HumanGateRequiredError` | The rail requires a verified human behind the agent. |
| `PaymentUnresolvedError` | The rail could not resolve the challenge (resource stayed 402). |
| `PaymentRailError` | Any other structured rail failure (`status`, `code`, `detail`). |

## AP2 mandate (optional)

`deriveMandate` calls the rail's `POST /api/ap2/mandate` to express an on-chain
SessionGrant as an AP2 mandate chain (Intent ← Cart ← Payment) for an AP2/A2A
counterparty. It **moves no money**. Heed the returned `onChainTruth`: re-verify the
SessionGrant on-chain before trusting any derived mandate.

```ts
const { mandates, onChainTruth } = await payer.deriveMandate({ grant });
```

## Config

| Option | Required | Default | Purpose |
| --- | --- | --- | --- |
| `baseUrl` | yes | — | Base URL of the Access0x1 rail. |
| `callerAuth` | no | — | Shared secret sent as `x-internal-secret`. |
| `fetchImpl` | no | global `fetch` | Injected fetch (tests / custom transport). |
| `payPath` | no | `/api/agent/pay` | Agent-pay endpoint path. |
| `mandatePath` | no | `/api/ap2/mandate` | AP2 mandate endpoint path. |

## Develop

```sh
npm install
npm run typecheck   # tsc strict, no emit
npm test            # vitest, mocked fetch — no network
npm run build       # emit dist/
```

## License

MIT.
